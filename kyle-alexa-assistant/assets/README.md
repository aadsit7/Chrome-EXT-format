# Kyle assets

All real art is in place — nothing left to upload.

| File | What it is | Used by |
|---|---|---|
| `alexa_skill_icon_small_108.png` | 108×108 skill icon (user art) | `skill.json` → `smallIconUri` |
| `alexa_skill_icon_large_512.png` | 512×512 skill icon (user art) | `skill.json` → `largeIconUri` |
| `alexa_skill_icon_large_512_no_padding.png` | Original no-padding upload (open mouth) | Source for the talk frames below |
| `kyle_talk_open_512.png` | Talking frame — mouth open (copy of the no-padding art) | Web page + APL animation |
| `kyle_talk_closed_512.png` | Talking frame — mouth closed (generated from the open frame: mouth erased with sampled skin color, closed smile drawn) | Web page + APL animation |

Everything is referenced via `refs/heads/<default-branch>` raw URLs, so a commit
to the default branch updates all surfaces:

```
https://raw.githubusercontent.com/aadsit7/Chrome-EXT-format/refs/heads/claude/bookmarks-buddy-extension-cuwn8o/kyle-alexa-assistant/assets/<filename>
```

To change any image, overwrite the file (same name) and — for the two skill
icons — re-run `ask deploy` so Amazon re-fetches them.
