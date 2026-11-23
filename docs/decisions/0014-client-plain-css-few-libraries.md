---
status: accepted
date: 2026-11-23
---
# 0014. The client uses plain CSS and few libraries

**Context.** The front end follows a custom dark design: glass cards, glowing edges, gradient
buttons and animated screen changes. The stack listed Material UI as the UI kit, and TanStack
Query, React Hook Form and Zod as recommendations. The app has about six small forms and two
pieces of server data (the account and its transactions).

**Options.** Styling: Material UI restyled to the design · plain CSS with design tokens. Forms and
data: the three libraries · TanStack Query alone · small hand-written functions.

**Decision.** React, Vite, React Router and `openapi-fetch` over the generated contract types.
Styling is plain CSS, with the design's colours, spacing and glows as custom properties, and the
three fonts self-hosted. There is no component kit. Forms use small validators for email, phone,
password and amount; data comes through one small loader. The server stays the final authority
on every rule.

**Consequences.** Screens map directly onto the designs and the download stays small. Keyboard and
screen-reader behaviour of custom controls is ours to build and test. Later chat and video
screens are styled by hand. If realtime updates make the loader grow, a data library can be
adopted by a later ADR.
