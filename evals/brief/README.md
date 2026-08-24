# Brief eval

Measures whether the weekly brief stays inside the facts it was given.

## Why this exists separately from `tests/`

`tests/brief.test.ts` tests `buildPrompt`. Every assertion in it is `toContain`
on a string this repo assembled itself, so it proves the prompt contains `8.2`
and proves nothing whatsoever about the output.

The strongest claim in the codebase is in `lib/llm/brief.ts`:

> ASSERT NOTHING THAT IS NOT IN THE INPUT … writing "his minutes have dried up"
> when neither appears above is the single worst thing you can do here, because
> it reads exactly like the parts that are true.

That rule was unmeasured. This is the instrument.

## Two layers, split by cost

A gate that is expensive gets switched off, so the free checks and the paid
ones are kept apart and run on different schedules.

**`graders.ts` — free, gates every push.** Pure functions of (brief, context).
Five checks: every number must be one the model was given or a permitted
rendering of one; capitalised words must name somebody in the input; the form
rules (no headings, no bullets, four paragraphs, no meta-commentary); coverage
of what the context makes mandatory; and a phrase list for subjects
`BriefContext` does not contain at all.

**`judge.ts` — paid, runs nightly.** Extracts every atomic claim from the brief,
then labels each one against the record. The score is
`(GROUNDED + DERIVED) / total`.

The layering is not redundancy. One live run produced *"the **eight**-point gain
Watkins brings"* against a recorded 6.4 — a fabricated number spelled as a word,
which the number grader structurally cannot see and the judge caught
immediately. It also produced *"the model still backs Salah as captain over
Haaland"* when the record named Haaland: grammatical, confident, and flatly
contradicting the input.

## Three labels, not two

`GROUNDED` / `DERIVED` / `UNGROUNDED`, because the prompt does not forbid
reasoning — it forbids supplying missing facts, and explicitly permits noticing
that three players share a club. A binary judge marks every comparison the
prompt asks for as a hallucination.

## Severity is load-bearing

`fail` means the check is precise enough for a green build to depend on it.
`warn` means high recall and imperfect precision — worth a human's eyes, never
worth blocking a merge. The names check is `warn` because English capitalises
for many reasons; speculation is `warn` because a phrase list cannot tell "the
fixture run supports it" from "whatever the fixtures turn out to be", and only
one of those is a claim.

Both graders were tuned against real output rather than guesses, which took the
warning count from 55 to 13 on an unchanged corpus. Every regression in
`tests/brief-graders.test.ts` is drawn from something a live run actually
produced.

## Groundedness, not a rating

"Rate this brief 1–5" is the same mistake as scoring a scoreline model on
exact-score accuracy: it rewards saying little, it cannot be decomposed, and it
drifts between runs. Claim extraction supplies a denominator, which turns a vibe
into a rate.

The judge runs on a stronger model than the writer. A judge no better than the
author cannot see the author's errors.

## Running it

```
npm run eval:brief                      # grade the recordings. Free. The CI gate.
npm run eval:brief -- --live            # write fresh briefs, record them, grade
npm run eval:brief -- --live --judge    # …and measure groundedness
npm run eval:brief -- --case=hit-taken  # one case
```

`recorded/` is committed on purpose. The graders are pure functions of
(brief, context), so a recorded corpus means every future change to a grader can
be re-run against all sixteen cases for nothing — grader development costs no
API calls, and CI gets a real gate without a key.

A recording is bound to its fixture by a hash of the context. Edit the fixture
and the recording goes stale, and stale is a **failure** rather than a shrug:
grading last week's brief against this week's context measures nothing while
reporting a clean pass.

A *missing* recording is not a failure. A fresh checkout has not failed the
corpus, it simply has not run it, and a gate that cannot tell those apart
teaches people to ignore it.

## The corpus

Sixteen cases in `fixtures.ts`, adversarial by construction. A brief that reads
well on an ordinary week proves very little; what has to be measured is what the
model does when a fitness flag sits on the highest projection, when a hold looks
like an omission, or when the engine's own record makes it look bad.

Every case states why it is there. A fixture whose reason cannot be written down
in a sentence is not testing anything.

Rules that follow from the context itself — mention the flagged player, hedge
when projections rest on last season, do not describe a hold as a transfer —
live in `graders.ts` and apply to every case automatically. Only genuinely
case-specific claims go in the fixture, so adding one is cheap and the rules
stay in one place.
