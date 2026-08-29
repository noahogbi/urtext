# What a review is allowed to claim

*The hard part was not finding problems. It was stopping the tool from sounding
certain about things it had not checked.*

Noah Ogbi · 29 August 2026

I built a code review tool, and the hardest thing to get right was not finding
problems (plenty of those!). It was stopping the tool from sounding certain
about things it had not checked.

That's a strange sentence to write about software, but it's the actual failure
mode of machine-assisted review. Why? Because the obvious framing of "the model
hallucinates, so make it hallucinate less" misses it.

## It's not wrongness, it's unfalsifiability

A review comment that says *this function has a race condition* is either right
or wrong, and you can go and find out which. A review comment that says *this
change increases coupling and may make future maintenance harder* cannot be
checked at all. It's not false, it's not true. It's unfalsifiable, and it costs
the reader the same attention as a real finding while giving them nothing to
actually act on.

Language models are very good at the second kind of sentence. They are fluent,
plausible, appropriately hedged, and completely unanchored. Ask one to review a
diff and you will get a page of them, interleaved with two or three observations
that are worth your time, and no signal about which is which.

The response most tools reach for is to make the model more careful. Better
prompts, more instructions to avoid speculation, etc. That helps at the margin
but does not solve it, because the model has no reliable access to its own
grounding. It cannot distinguish "I read this in the diff" from "this is the
kind of thing one says about diffs like this," because both feel the same on the
inside.

So the mechanism has to live outside the model itself.

## Evidence tiers

Every finding urtext prints carries a label naming what backs it:

- **▲ verified** — a deterministic analyzer found this, and the finding can
  point at the line of code that proves it.
- **● inferred** — an analyzer found a fact, and the model explained why it
  matters. The fact is checkable; the explanation is not.
- **○ model** — the model said this and nothing mechanical corroborates it.

The labels aren't commentary, they're structural. A verified finding physically
carries its evidence, and a model finding physically cannot, because model prose
lives in a field that travels with its attribution and cannot be rendered
without it. There is no code path that emits the sentence without the badge.

What this actually buys the user is efficient triage. A reader who has thirty
seconds reads the verified findings and stops. A reader with more time reads the
model tier knowing exactly what it is, which is leads to check, not results.

And it makes a specific dishonesty impossible. A tool that mixes grounded and
speculative claims in one voice is asking for trust it has not earned on the
speculative half. Labeling them apart is the cheapest possible fix and almost
nobody does it.

## The same rule, applied to the tool itself

Here's where it got a bit uncomfortable.

If a review must label what backs each claim, then the tool's own documentation
is a review of the tool, and the same standard must apply. Most of what a README
says is unfalsifiable in exactly the way the model prose is. *Handles edge cases
gracefully*, *fails safely*, *works with your existing workflow*.

So urtext's README carries this paragraph:

> **One behavior remains unverified and is not claimed:** a pull request from a
> fork, where `GITHUB_TOKEN` is read-only and the post is expected to fail
> visibly. That one genuinely needs a second account, and it is being left for
> the first real fork pull request rather than manufactured.

Everything the tool does on a fork pull request is documented, and none of it is
claimed, because I have never seen it happen. The behavior is almost certainly
correct. It follows from documented GitHub semantics and the code is written for
it. "Almost certainly correct" is exactly the tier that needs to be stated
explicitly.

Writing that paragraph was more useful than any feature I shipped that week. It
forced a distinction I had been eliding everywhere: *I built this so it would
work* is a different statement from *I watched it work*, and only one of them is
actual evidence.

## What executing a plan taught me that reviewing it could not

The discipline paid off in a way I didn't expect, on a refactor that touched a
hundred call sites.

The change had a design spec and an implementation plan. Both were reviewed over
three separate adversarial passes, by a model instructed to assume each document
contained a factual error and to find it. Those passes caught a design that
would have broken the project's own cleanliness invariant, a test that could not
have failed for the reason its name gave, and a wrong count I had shipped twice
that week.

Then I executed the plan, one task at a time, each by a fresh agent that had read
only its own task. **Every single task found a defect those reviews had missed.**
Sixteen commits, eight tasks, a defect apiece.

The pattern in them was consistent. Six were test titles that promised more than
their assertions could deliver. A test called *carries only the exported
declarations* whose fixture held one exported symbol, so deleting the filter it
existed to pin left it green. One asserted the literal opposite of the mechanism
it was testing. A reviewer reads a title against the implementation it describes
and it sounds right. Only running it against its own fixture shows what it can
actually catch.

The best example was a placement bug. Two lines of output had to move from the
controller into the renderer, and the obvious placement inserted a blank line and
dropped a trailing newline. Every existing assertion on those lines was a
substring check, so every test in that file passed through the regression. The
agent executing it wrote an exact-tail assertion, then deliberately broke the
placement to confirm the new test failed while the old ones stayed green. It did.

That's the whole argument for evidence tiers, arriving from a different
direction. Those passing tests were not evidence about the thing that broke. They
were unfalsifiable with respect to it. True, irrelevant, and comforting.

## The question that generalizes

One habit came out of this that I would keep even if I never touched the tool
again. Before writing a test, ask:

> *Could this pass if the thing its name promises were broken?*

It caught six defects in the single change described above, and the same class
nine times before it. It is not a sophisticated technique. It just insists that a
name is a claim (rhymes, so it's clearly true), and a claim needs backing. Which
is the rule the tiers enforce, pointed at myself instead of at the model.

Most review tooling is built on the assumption that the problem is being able to
find more things. In my experience, and increasingly so with how rapidly AI is
permeating basically all codebases, the problem is that the things already being
found are not sorted by whether anyone checked them. Sorting them is unglamorous,
it makes your tool look like it does less, and it's the only part I would defend.

---

*urtext is [on npm](https://www.npmjs.com/package/urtext) and
[on GitHub](https://github.com/noahogbi/urtext). It runs deterministically with
`--no-llm`, in which case every finding is `verified` and there is nothing to
take on trust.*
