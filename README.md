# OpenAcademy: Training Courses From Your Own Procedures

[![Deploy with Clawnify](https://app.clawnify.com/deploy-button.svg)](https://app.clawnify.com/deploy?repo=clawnify/OpenAcademy)

Turn the procedures, policies and manuals your company already has into training courses: AI drafts the modules, lessons and quizzes from your documents, a presenter you choose reads each video lesson, and you edit everything before it goes out. Assign courses by role or department, everyone takes them from a personal link, and you keep the record of who completed which version, with their score and what they confirmed. An open-source app template provided by [Clawnify.com](https://clawnify.com).

Built with **React + Tailwind** on a **Hono API**, a **SQLite** database and object storage, with a full OpenAPI surface so an agent can drive it.

## What it does

Most mandatory training is either a generic course that never mentions how your company actually works, or a slide deck someone presents once. Auditors increasingly ask for the first thing neither gives you: evidence that each person was trained on *your* procedure, the current version of it, and understood it. OpenAcademy is built around that:

- **Courses come from your documents.** Paste a procedure, upload text files or read a web page, and draft the course from them. The draft is told never to invent a rule your documents don't contain. Write or edit any lesson yourself.
- **Three kinds of lessons.** Text (Markdown), video, and quizzes with a pass mark, single or multiple correct answers, an explanation per question, and unlimited retakes.
- **Presenter videos from a script.** Pick a presenter, write what they say, and the app records the voice and animates their photo to it. Or upload a video you recorded. Learners always see an AI-generated presenter marked as such, and the app refuses to make one from someone's photo until their consent is recorded.
- **Published versions.** Learners only ever see a frozen, published version. Editing the draft changes nothing for someone half-way through, and every completion names the version the person took. When a procedure changes, publish again and, if you choose, everyone who completed the old version takes the new one.
- **Assigned by group.** Groups are roles, departments or sites. A course is required for groups, so a new starter added to a group is assigned at once. Courses can renew every N months.
- **No accounts for learners.** Each person gets their own link per course. They read, watch, answer, confirm, and get a printable certificate.
- **The record.** Every assignment, start, lesson, quiz attempt and confirmation is logged with its time. Filter by course, group or status, see who is overdue, and export everything to CSV for HR or an auditor.

## How it works

1. **Create a course** and add the documents it should teach.
2. **Draft it.** Modules, lessons, a presenter script per module and a quiz per module. Review every answer against the source.
3. **Make the videos.** Add presenters with a photo and their recorded consent, then make each video lesson from its script, or upload your own.
4. **Assign.** Choose the groups that must take it, set a due period and a renewal period.
5. **Publish.** Everyone in those groups gets their personal link. Overdue people show up on the overview, ready to be reminded.

## Working with an agent

The app is designed to be run alongside an AI agent, with a clear split:

- The agent extracts text from PDFs and Word files and adds it as sources, drafts and reviews courses, imports people from an HR export, and reminds overdue people with their own links.
- A person publishes, because publishing sends training to everyone in a group, and a person records a presenter's consent. The API refuses both to an agent.

## Running it

```bash
pnpm install
pnpm dev          # the editor on http://localhost:5174, the API on :8791
pnpm test         # the API and learner pages against a real SQLite database
```

AI drafting and presenter videos need an OpenRouter key (`OPENROUTER_API_KEY`); everything else works without one. The models are chosen in Settings: drafting picks the best one your key can use, the voice defaults to a multilingual text-to-speech model, and the presenter video model animates a photo to a voice track.

Learner pages are served by the API under `/learn/<token>`, rendered on the server so they work on any phone without the editor.

## What it deliberately doesn't do

- **It doesn't send email.** Every assignment has a personal link; send it through your own email, your HR system, or an agent. The records page lists who is overdue with their links.
- **It doesn't prove someone watched every second.** A video lesson's Continue button waits for the end of the video, but the record says the person marked it done, not that they paid attention. Quizzes and the final confirmation are the evidence.
- **It doesn't read PDFs or Word files itself.** Add their text as a source, or let an agent extract it.
- **It doesn't include ready-made compliance content.** Courses are built from your documents; the content is yours.

## License

MIT
