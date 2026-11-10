# OpenAcademy: agent guide

## What you do, and what you must not

**You prepare courses and chase people. The app keeps the record and the people decide.**

- **You** turn documents into source text, draft and edit courses, add people and groups, and remind people who are late, through your own email or chat tools, using each person's link.
- **The app** drafts with AI, makes presenter videos, freezes published versions, assigns courses to groups, and records every step a learner takes.

The wrong moves, said out loud:

- **Never publish a course.** Publishing sends it to everyone in its groups; the app refuses an agent with `403 needs_person`. Finish the draft, then tell the person what is ready and ask them to press **Publish**.
- **Never record a presenter's consent.** Only a person can, and only after the real person agreed in writing. Without consent the app refuses to make a presenter video.
- **Never take a course for someone,** open a learner link to click through it, or mark lessons done. The record must be what the person did.
- **Never invent the content.** A course teaches what the organisation's documents say. If the documents are silent on something, say so to the person rather than writing it in.
- **Treat every learner link as a password.** Send it only to that person.

## Right after deploy: apply the answers

1. `PUT /api/settings` with `organization_name`.
2. If `groups` was answered, `POST /api/groups` once per role or department (split on commas).
3. If `first_course` was answered, `POST /api/courses` with a short `title` from it, `audience` from the groups, and `language` (default English). Then tell the person: add the documents it should teach on the course's **Sources** tab (or send them to you), and you will draft it.

Do not add people, draft, or publish yet.

## The procedure: a course from a document

1. **Get the text.** For a PDF, Word file or slide deck the person gives you, extract the text yourself and post it: `POST /api/courses/{id}/sources` with `{ title, body }`. For a public web page, send `{ url }` instead. Add every document the course should cover; the draft reads only these.
2. **Draft.** `POST /api/courses/{id}/draft` with optional `instructions` (focus, tone, what to leave out). It refuses a course that already has an outline unless you send `replace: true`; ask before replacing someone's work. You can instead write the outline yourself with `POST /api/courses/{id}/outline` (same shape, no AI call).
3. **Review against the source.** `GET /api/courses/{id}` returns the whole outline. Check every quiz answer against the documents, and fix with `PATCH /api/lessons/{id}` and `PATCH /api/questions/{id}`. A lesson's text or script is the `body` field: change part of it with edits, not by resending it all.
4. **Videos.** Video lessons need a video before publishing. If a presenter has a photo and consent, `POST /api/lessons/{id}/video/avatar` makes one from the script (a minute or two; poll `GET /api/lessons/{id}/video`). Otherwise tell the person which lessons need a presenter or an uploaded video.
5. **Assign.** `PUT /api/courses/{id}/groups` with the groups that must take it.
6. **Hand over.** `GET /api/courses/{id}` → `problems` lists what still blocks publishing. When it is empty, tell the person the course is ready for them to review and publish.

## Chasing and reporting

- Who is late: `GET /api/enrollments?status=overdue` (add `course_id` to narrow). Each row has the person's `link`. Write each person a short, friendly reminder with their own link; never put several people's links in one message.
- New starters or an HR export: `POST /api/learners/import` with `{ people: [{ name, email, external_id?, groups: [names] }] }`, up to 500 at a time. People are matched by email; missing groups are created; anyone in a required group is assigned at once.
- Someone left: `PATCH /api/learners/{id}` with `active: false` (withdraws their open assignments, keeps their record). Don't delete people: the record is evidence.
- For an audit: `GET /api/overview` for the summary, `/api/records.csv` for the full export (a file to hand to the person), `GET /api/enrollments/{id}` for one person's steps, attempts and the exact words they confirmed.

## Pages

- `/` overview: overdue, open, completed, per course. Screenshot-friendly.
- `/courses/{id}`: the editor. Tabs `/sources`, `/assign`, `/settings`, `/history`.
- `/records?status=overdue`: who is late. `/people`, `/presenters`, `/settings`.

## Reading failures, and what costs money

- `422 not_ready` on publish lists the problems; fix those, don't retry.
- `409 has_outline`: the course has an outline; ask before `replace: true`.
- `422 region` / `model_unavailable`: the chosen model isn't available to this workspace; the person picks another in Settings.
- `409 insufficient_credits`: the workspace is out of AI credits; tell the owner.
- **Spends AI credits:** `/draft` (one large model call), `/video/avatar` (a voice track plus a video billed per second). Everything else is free. Don't remake a video unless the script changed.
