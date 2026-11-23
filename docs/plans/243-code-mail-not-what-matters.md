# Plan 243: a one-time code's mail is never in What matters

## The request

> on 'what matters' here on my personal use, i noticed that this was in here, and its just an authorization code, it should not be in the 'what matters' section

The owner's screenshot: Today held "IBP favorite accounts transaction awaiting verification, the email says", an `alert`
the dated reader made from Banco Nacional's "Comprobación Seguridad" (bncontacto@bncr.fi.cr): "Usted está realizando la
transacción Incluir cuentas favoritas por IBP que requiere ser confirmada mediante un código de verificación", then the
six-digit code. It came from the 14-day check that plan 239 let finish.

## What exists

- Plan 72's `findCode(subject, body)` (`packages/core/src/codes.ts`): six digits standing alone, near a word that announces a
  code in any language ("code", "código", "OTP", "clave de verificación" …); ids, amounts, phones, references, dates and
  quoted history are left out.
- The digest already skips such mail (`packages/backend/src/today.ts`: "a sign-in code isn't reading").
- The dated reader (`DatedWorker.consider`, `packages/backend/src/dated.ts`) has no such rule. Its cost filter reads a
  person's mail whatever its words, and `bncontacto@bncr.fi.cr` is a person by `automatedLevel` (no list, not bulk, no role
  word, a plain domain; Gmail labelled it IMPORTANT and Personal). So the code mail reached the model, which called the
  pending transaction an alert.

## Design (as revised after the Codex review)

The reader reads the mail as before. In `checkDates`, the local checks every item passes before it's stored: in a message
`findCode` finds a code in, an `alert`, `respond`, `expire` or `ask` (the kinds a scam's pressure is checked on, `PRESSED`)
whose own words, its text or its quote, name that code (`namesCode`: a word that announces a code in any language, or its
digits) is the code's step, done now or never, and is no item. It's checked before the request is counted, so a code mail
that asks nothing else is "nothing asked", and its conversation doesn't wait on you either.

A bill (`pay`), a plan, a delivery and anything else the mail says stay, and so does a request that doesn't name the code
("Firme el contrato de renovación antes del 20"). A settlement or a move of an open item is untouched.

The item already made in the owner's profile stays until they press Done or Remove: nothing rewrites stored items.

## Tests

`packages/backend/src/dated.test.ts`, "plan 243": the code's alert and its "enter the code" request are no items and
nothing's asked, while a ₡ bill and a renewal request in the same mail stay; a customer code beside a suspension alert that
doesn't name it keeps the alert; and the owner's case through the reader: a person-like bank address, read once, nothing
kept, its conversation not in Needs you. The first and third fail without the fix.

## Perf

`findCode` is linear over the text the reader already holds, once per message read; `namesCode` once per item of a code mail.

## Revisions after the Codex review

The first design dropped a code mail before any model read it, with an exception for a mail that names an amount. Codex:

1. `amountsOf` doesn't know ₡ or CRC, so the plan's own colón bill would have been dropped. Moot: nothing is dropped whole.
2. `findCode` can't tell a customer code from a one-time code ("Customer code 482913 … pay by Friday"). Now only an item
   that names the code goes, and never a `pay`; a test keeps a customer code's suspension alert.
3. A code mail can carry another deadline. Kept: the model reads the whole mail, and only the code's own items go.
4. Dropping mail with an item open would skip settlements and moves. They're untouched.
5. A partial body can't prove there's nothing else. Moot: the mail is read; "nothing asked" keeps its whole-text rule.
6. Code mail would still take the 14-day check's places, then be dropped. Moot: it's read, as any picked mail is.
7. Consuming the mark alone would leave a person-like sender's conversation waiting in Needs you. The code's request is
   removed before it's counted, so "nothing asked" is written and the conversation leaves Needs you; tested.

## What the Codex code review changed

1. A customer code beside a later deadline ("suspended on November 20" under "customer code 482913") lost the deadline.
   A code is used now: an item with a day past the mail's own is never the code's step.
2. "Send me the source code before the 20th" in a login-code mail lost the request: kept by the same rule.
3. The code's digits matched inside an id ("contract A482913"): `namesCode` reads digits with `findCode`'s own boundaries.
4. A code laid out one digit per box ("4 8 2 9 1 3"), which `findCode` reads, wasn't named: now it is.
5. "Confirm by replying with your code" became a confirmation's ask before the rule ran: the rule now runs first.

Each has a case in "Codex code review: …" under plan 243, and each fails on the first commit.

## Out of scope

Login notices ("Inicio de sesión en Banca en Línea") with no code: the model decides those as before.
