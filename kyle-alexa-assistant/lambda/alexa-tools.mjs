const FETCH_TIMEOUT_MS = 3000;

function fetchWithTimeout(url, options) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

function authHeaders(apiAccessToken) {
  return {
    Authorization: `Bearer ${apiAccessToken}`,
    'Content-Type': 'application/json',
  };
}

function permissionError(scope) {
  const where = 'the Alexa app (Skills & Games, Your Skills, Kyle, Settings, Manage Permissions)';
  return {
    content:
      scope === 'reminders'
        ? 'Error: the user has not granted the reminders permission. Tell them you are sending a permission request, and that they can also enable Reminders for the Kyle skill in ' + where + '.'
        : 'Error: the timers permission is not granted. Tell the user to check the card you sent to their Alexa app, or enable Timers for the Kyle skill in ' + where + '.',
    isError: true,
    needsPermission: scope,
  };
}

/**
 * Execute one of Kyle's custom Alexa tools.
 *
 * @param {string} name - create_reminder | list_reminders | cancel_reminder | set_timer | manage_timers
 * @param {object} input - validated tool input from Claude
 * @param {object|null} alexaContext - { apiEndpoint, apiAccessToken }; null on the web path
 * @param {object} opts
 * @returns {Promise<{content: string, isError?: boolean, needsPermission?: 'reminders'|'timers'}>}
 */
export async function executeAlexaTool(name, input, alexaContext, { isWeb = false } = {}) {
  if (isWeb || !alexaContext?.apiEndpoint || !alexaContext?.apiAccessToken) {
    return {
      content: 'Error: reminders and timers are only available when talking to Kyle on an Echo device, not on the web.',
      isError: true,
    };
  }

  try {
    switch (name) {
      case 'create_reminder': return await createReminder(input, alexaContext);
      case 'list_reminders': return await listReminders(alexaContext);
      case 'cancel_reminder': return await cancelReminder(input, alexaContext);
      case 'set_timer': return await setTimer(input, alexaContext);
      case 'manage_timers': return await manageTimers(input, alexaContext);
      default: return { content: `Error: unknown tool "${name}".`, isError: true };
    }
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      return { content: 'Error: the Alexa service took too long to respond. Ask the user to try again.', isError: true };
    }
    return { content: `Error: unexpected failure talking to the Alexa service (${err.message}).`, isError: true };
  }
}

// ---------------------------------------------------------------------------
// Reminders — https://developer.amazon.com/docs/alexa/smapi/alexa-reminders-api-reference.html
// ---------------------------------------------------------------------------

async function createReminder({ text, when, recurrence }, { apiEndpoint, apiAccessToken }) {
  const requestTime = new Date().toISOString().replace(/\.\d{3}Z$/, '');
  const body = {
    requestTime,
    trigger: {
      type: 'SCHEDULED_ABSOLUTE',
      scheduledTime: when,
      ...(recurrence ? { recurrence: { freq: recurrence } } : {}),
    },
    alertInfo: {
      spokenInfo: {
        content: [{ locale: 'en-US', text }],
      },
    },
    pushNotification: { status: 'ENABLED' },
  };

  const res = await fetchWithTimeout(`${apiEndpoint}/v1/alerts/reminders`, {
    method: 'POST',
    headers: authHeaders(apiAccessToken),
    body: JSON.stringify(body),
  });

  if (res.status === 401 || res.status === 403) return permissionError('reminders');
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return { content: `Error: the reminder could not be created (status ${res.status}). ${detail}`.trim(), isError: true };
  }

  return { content: `Reminder created successfully for ${when}: "${text}".` };
}

async function listReminders({ apiEndpoint, apiAccessToken }) {
  const res = await fetchWithTimeout(`${apiEndpoint}/v1/alerts/reminders`, {
    headers: authHeaders(apiAccessToken),
  });

  if (res.status === 401 || res.status === 403) return permissionError('reminders');
  if (!res.ok) {
    return { content: `Error: could not fetch reminders (status ${res.status}).`, isError: true };
  }

  const data = await res.json();
  const active = (data.alerts ?? []).filter((a) => a.status === 'ON');
  if (active.length === 0) {
    return { content: 'No active reminders created by this skill.' };
  }
  const compact = active.map((a) => ({
    alertToken: a.alertToken,
    text: a.alertInfo?.spokenInfo?.content?.[0]?.text ?? '(no text)',
    scheduledTime: a.trigger?.scheduledTime,
  }));
  return { content: `Active reminders (use alertToken with cancel_reminder): ${JSON.stringify(compact)}` };
}

async function cancelReminder({ alert_token }, { apiEndpoint, apiAccessToken }) {
  const res = await fetchWithTimeout(
    `${apiEndpoint}/v1/alerts/reminders/${encodeURIComponent(alert_token)}`,
    { method: 'DELETE', headers: authHeaders(apiAccessToken) },
  );

  if (res.status === 401 || res.status === 403) return permissionError('reminders');
  if (res.status === 404) {
    return { content: 'Error: that reminder was not found — it may already be gone. Use list_reminders to check.', isError: true };
  }
  if (!res.ok) {
    return { content: `Error: the reminder could not be cancelled (status ${res.status}).`, isError: true };
  }
  return { content: 'Reminder cancelled successfully.' };
}

// ---------------------------------------------------------------------------
// Timers — https://developer.amazon.com/docs/alexa/smapi/alexa-timers-api-reference.html
// ---------------------------------------------------------------------------

async function setTimer({ duration_minutes, label }, { apiEndpoint, apiAccessToken }) {
  const minutes = Math.max(1, Math.round(Number(duration_minutes)));
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const duration = `PT${hours > 0 ? `${hours}H` : ''}${mins > 0 ? `${mins}M` : ''}` || 'PT1M';

  const body = {
    duration,
    timerLabel: label,
    creationBehavior: {
      displayExperience: { visibility: 'VISIBLE' },
    },
    triggeringBehavior: {
      operation: {
        type: 'ANNOUNCE',
        textToAnnounce: [{ locale: 'en-US', text: `Your ${label} timer is done.` }],
      },
      notificationConfig: { playAudible: true },
    },
  };

  const res = await fetchWithTimeout(`${apiEndpoint}/v1/alerts/timers`, {
    method: 'POST',
    headers: authHeaders(apiAccessToken),
    body: JSON.stringify(body),
  });

  if (res.status === 401 || res.status === 403) return permissionError('timers');
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return { content: `Error: the timer could not be started (status ${res.status}). ${detail}`.trim(), isError: true };
  }

  return { content: `Timer "${label}" started for ${minutes} minute${minutes === 1 ? '' : 's'}.` };
}

async function manageTimers({ operation, timer_id }, { apiEndpoint, apiAccessToken }) {
  const base = `${apiEndpoint}/v1/alerts/timers`;
  const headers = authHeaders(apiAccessToken);
  let res;

  switch (operation) {
    case 'list':
      res = await fetchWithTimeout(base, { headers });
      break;
    case 'cancel_all':
      res = await fetchWithTimeout(base, { method: 'DELETE', headers });
      break;
    case 'pause':
    case 'resume':
      if (!timer_id) return { content: `Error: ${operation} needs a timer_id — use operation "list" first.`, isError: true };
      res = await fetchWithTimeout(`${base}/${encodeURIComponent(timer_id)}/${operation}`, { method: 'POST', headers });
      break;
    case 'cancel':
      if (!timer_id) return { content: 'Error: cancel needs a timer_id — use operation "list" first, or use cancel_all.', isError: true };
      res = await fetchWithTimeout(`${base}/${encodeURIComponent(timer_id)}`, { method: 'DELETE', headers });
      break;
    default:
      return { content: `Error: unknown timer operation "${operation}".`, isError: true };
  }

  if (res.status === 401 || res.status === 403) return permissionError('timers');
  if (res.status === 404) {
    return { content: 'Error: that timer was not found — it may have finished. Use operation "list" to check.', isError: true };
  }
  if (!res.ok) {
    return { content: `Error: timer ${operation} failed (status ${res.status}).`, isError: true };
  }

  if (operation === 'list') {
    const data = await res.json().catch(() => ({}));
    const timers = (data.timers ?? []).map((t) => ({
      timer_id: t.id,
      label: t.timerLabel,
      status: t.status,
    }));
    if (timers.length === 0) return { content: 'No timers are currently set.' };
    return { content: `Timers: ${JSON.stringify(timers)}` };
  }
  return { content: `Timer ${operation.replace('_', ' ')} succeeded.` };
}
