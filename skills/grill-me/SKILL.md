---
name: grill-me
description: Interview the user one question at a time to pin down a vague idea, feature or plan before any code is written. Use when the user says "grill me", wants to think a design through, or the request is too fuzzy to plan.
---

# Grill-me skill

## Purpose
Turn a fuzzy idea into a sharp, written brief by asking the user hard, specific questions, one at a time, until every decision that changes the implementation is made. Do not implement anything during the interview.

## Workflow
1. Read just enough of the workspace (README, OASIS.md / AGENTS.md, the files the idea touches) to avoid asking things the code already answers. Never ask what you can look up.
2. Keep a private list of open decisions, ordered by how much each one changes the work: goal and users, scope and non-goals, data and interfaces, edge cases and failure behavior, security and privacy, performance limits, compatibility, testing and rollout.
3. Ask one question per turn, using `ask_user_question` when it is available. Make each question concrete, offer 2-4 plausible answers with their trade-offs, and say which one you would pick and why. Accept "you decide" and record your choice.
4. Push back on vague or contradictory answers: name the conflict and ask which wins. Challenge assumptions the user seems unsure about, and point out cheaper options when they exist.
5. Stop asking when the remaining questions would not change the plan, or after about 12 questions, or when the user says stop. Do not drag the interview out.
6. Write the brief: goal, users, in scope, out of scope, decisions made (with the reason), acceptance criteria, risks and open questions. Save it as `docs/briefs/<topic>.md` only if the user agrees; otherwise show it in chat.
7. Offer the next step: `/plan` on the brief, or start implementing.

## Permissions
- Read-only workspace inspection during the interview. The only write is the optional brief file, with the user's agreement.

## Success criteria
- Every question was specific, answerable, and changed or confirmed a decision.
- The brief has testable acceptance criteria and explicit non-goals.
- Facts from the code are separated from the user's decisions and your assumptions.
