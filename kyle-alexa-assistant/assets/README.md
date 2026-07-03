# Kyle assets

These PNGs are **generated placeholders** so the raw GitHub URLs referenced by
`skill.json`, `web/index.html`, and the APL document resolve immediately.

**Replace them with your real art — same filenames, drop-in overwrite:**

| Repo file (overwrite this) | Your local file (`C:\Users\adsit\OneDrive\AI\alexa_skill_icons`) |
|---|---|
| `alexa_skill_icon_small_108.png` | `alexa_skill_icon_small_108.png` |
| `alexa_skill_icon_large_512.png` | `alexa_skill_icon_large_512.png` |
| `kyle_talk_open_512.png` | the no-padding 512 variant (open-mouth / talking frame) |
| `kyle_talk_closed_512.png` | a closed-mouth copy of the 512 — if you don't have one, keep the placeholder or duplicate the open frame; the web page can also fall back to a CSS mouth-cover (see `web/index.html`) |

Everything is referenced via `refs/heads/<default-branch>` raw URLs, so changes
take effect as soon as your commit lands on the default branch:

```
https://raw.githubusercontent.com/aadsit7/Chrome-EXT-format/refs/heads/claude/bookmarks-buddy-extension-cuwn8o/kyle-alexa-assistant/assets/<filename>
```

After replacing the two skill icons, re-run `ask deploy` so Amazon re-fetches them.
