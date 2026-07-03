const FETCH_TIMEOUT_MS = 3000;

function fetchWithTimeout(url, options) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

/**
 * Execute one of Kyle's custom Alexa tools.
 *
 * @param {string} name - tool name (create_reminder | set_timer)
 * @param {object} input - validated tool input from Claude
 * @param {object|null} alexaContext - { apiEndpoint, apiAccessToken }; null on the web path
 * @param {object} opts
 * @returns {Promise<{content: string, isError?: boolean, needsPermission?: boolean}>}
 */
export async function executeAlexaTool(name, input, alexaContext, { isWeb = false } = {}) {
  if (isWeb || !alexaContext?.apiEndpoint || !alexaContext?.apiAccessToken) {
    return {
      content: 'Error: reminders and timers are only available when talking to Kyle on an Echo device, not on the web.',
      isError: true,
    };
  }

  try {
    if (name === 'create_reminder') return await createReminder(input, alexaContext);
    if (name === 'set_timer') return await setTimer(input, alexaContext);
    return { content: `Error: unknown tool "${name}".`, isError: true };
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      return { content: 'Error: the Alexa service took too long to respond. Ask the user to try again.', isError: true };
    }
    return { content: `Error: unexpected failure talking to the Alexa service (${err.message}).`, isError: true };
  }
}

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
    headers: {
      Authorization: `Bearer ${apiAccessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (res.status === 401 || res.status === 403) {
    return {
      content:
        'Error: the user has not granted the reminders permission. Tell them you are sending a permission request, and that they can also enable Reminders for the Kyle skill in the Alexa app.',
      isError: true,
      needsPermission: true,
    };
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return { content: `Error: the reminder could not be created (status ${res.status}). ${detail}`.trim(), isError: true };
  }

  return { content: `Reminder created successfully for ${when}: "${text}".` };
}

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
    headers: {
      Authorization: `Bearer ${apiAccessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (res.status === 401 || res.status === 403) {
    return {
      content:
        'Error: the timers permission is not granted. Tell the user to enable Timers for the Kyle skill in the Alexa app (Skills & Games, Your Skills, Kyle, Settings, Manage Permissions).',
      isError: true,
    };
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return { content: `Error: the timer could not be started (status ${res.status}). ${detail}`.trim(), isError: true };
  }

  return { content: `Timer "${label}" started for ${minutes} minute${minutes === 1 ? '' : 's'}.` };
}
