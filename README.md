# Audiobook Studio

Turn any book (.docx, .pdf, .txt) into a **multi-voice audiobook**: Claude finds the
characters and narrator, auto-casts matching ElevenLabs voices, and each chapter is
rendered with dialogue spoken in character voices and prose in the narrator's voice.

## Quick start

```bash
cp .env.example .env.local   # then fill in your keys
npm install
npm run dev
```

Required keys in `.env.local`:

| Key | Used for |
|---|---|
| `ANTHROPIC_API_KEY` | Character analysis, voice casting, dialogue attribution |
| `ELEVENLABS_API_KEY` | Voice catalog, previews, audio generation |
| `ELEVEN_CONCURRENCY` | Match your ElevenLabs plan cap (Free 2, Starter 3, Creator 5, Pro 10) |

## Workflow

1. **Upload** a book — chapters are detected automatically (heuristics, LLM fallback).
2. **Analyze characters** — reads the whole book, builds a cast list with profiles and
   verbatim quotes, and profiles the narrator (POV-aware).
3. **Voices** — auto-cast assigns a matching ElevenLabs voice to every character +
   narrator with a rationale. Override any pick, tweak stability/style/speed, and
   preview using the character's actual lines from the book.
4. **Chapters** — "scripting" attributes every span of text to a speaker (coverage-
   validated so no words are dropped; review/reassign in the script viewer), then
   generation renders each segment and stitches the chapter MP3 with request-stitched
   prosody (`previous_text`/`next_text` + request-id chains).
5. **Listen** — built-in player (seek, ±15s, speed), per-chapter downloads, zip export.

## Cost & modes

- **Final** (`eleven_multilingual_v2`): best long-form quality, 1 credit/char.
- **Draft** (`eleven_flash_v2_5`): half cost, faster — great for iterating.
- Segment audio is cached by content+voice+settings hash: changing one character's
  voice marks affected chapters *stale* and regenerating only re-renders that voice's
  lines. Credit estimates are shown before you spend anything; header shows live usage.

## Stack

Next.js (App Router) · shadcn/ui · Drizzle + SQLite (`./data/app.db`) · AI SDK +
Anthropic (`claude-sonnet-5`) · ElevenLabs API. Audio lives in `./data/audio/`.
Long-running work runs as resumable DB-tracked jobs (`after()` + polling) — fine
locally with no serverless timeouts.
