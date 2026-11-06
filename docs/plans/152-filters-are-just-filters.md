# Plan 152: Filters are just filters

- **Status:** built and on `main`.
- **Builds on:** plan 85 (filters are Free), plan 147 (what AI shows).

## The request

> Yeah, so the name is just filters, not AI filters. Make sure this is sold on the main branch. If not, rebase and merge it onto the main branch.

(Dictated: "sold" is "solved". It answered "plain Filters and the icon change?")

## What exists

Nothing in the app is a feature called "AI filters", and a filter uses no AI once it exists: a model only turns a sentence into a rule, once, on the user's provider.

## The change

- Settings → Dev mode's line for `ANTHROPIC_API_KEY` says "creating filters", in `en` and `es`. It was the one place naming them.
- Sparkles means AI. The sidebar's Filters row and the learned-filter banner, which run on no model, take `ListFilter`, the icon Settings → Filters already has.

## What stays

- **"Create with AI" and "Create filter with AI".** They name what the button does, and that the sentence goes to a provider.
- **The "AI" badge on a filter made that way.** It says where the filter came from, beside "Automatic" and "Learned".
- **The sidebar's category suggestions keep their Sparkles:** those can come from a model (plan 134).
- **Tests' titles and plans,** which describe the generating path and its history.

## Tests

The filter specs and the screens with the sidebar, against their baselines, in light and dark.
