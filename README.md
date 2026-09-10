
## Demo

1. Download **[`dist/re-playable.html`](dist/re-playable.html)** — one file, nothing to install.
2. Drag your playables onto the page. One or a hundred.
3. Press **Fix all**, then **Download all**.


| Problem | Fix |
|---|---|
| The button calls another network's SDK | Rewritten to Google's `ExitApi.exit()` |
| The ad navigates by itself | Rewritten. Google rejects self-navigation it can reach |
| Built for MRAID, ironSource or Meta | A stand-in is installed so the ad still starts and still exits |
| `mraid.js` referenced but absent on Google | Removed |
| Google's `exitapi.js` missing or misplaced | Added as a proper tag in the head |
| Browser storage, which Google prohibits | Swapped for an in-memory equivalent |
| System-style pop-up dialogs | Turned into no-ops |
| Sound before the first tap | Held until the user touches, and stopped on exit |
| Missing orientation, viewport, charset, doctype | Added |
| Filenames with spaces; assets buried in a folder | Cleaned and flattened |

### The failure this exists to prevent

An AppLovin playable waits for AppLovin's SDK before it starts. On Google that SDK does not exist,
so the ad sits on a black screen forever — and passes every file check, because the file is
perfectly valid. The stand-in answers that wait immediately. It is the single most valuable thing
the converter does, and it is invisible unless you know to look for it.

---

## The policy review

Optional, off until you paste an API key, and it never changes the readiness score.

An AI reads the ad's artwork and text and cross-checks them against the
[Google Ads policies](https://support.google.com/adspolicy/answer/6008942). This matters most for
playables that **draw their words instead of writing them**: a canvas ad renders every headline and
button into an image, so the automatic copy checks have nothing to read and the AI is the only pass
that can see them.

It is given Google's policy text and told to judge against that alone and quote the sentence it
relies on. Every quote is checked against the source before you see it, so a paraphrased or invented
one is marked **unsourced** rather than presented as Google's wording.

Works with Gemini, Claude, OpenAI, Kimi, Qwen, GLM, or any OpenAI-compatible endpoint. The key goes
straight from the page to the service you chose and is remembered only in your browser.

---

## Where the rules come from

Every check names the source it rests on — Google's own pages, the other networks' playable
specifications, or the browser's own behaviour. **[`docs/validation-sources.md`](docs/validation-sources.md)**
lists all 54 of them: what each rests on, whether the tool fixes it or hands it back, and the
sentence the source states.

That document is generated from the same table the tool checks against, and the test suite fails if
a check is added without declaring a source. So it cannot quietly drift away from what the tool
actually does.

---

## What it does not promise

A converted file has a far better chance of running correctly and staying clear of policy trouble.
That is an improvement in the odds, not an approval.

Google's own validator and its policy reviewers still decide. Before uploading for real, put the
converted `.zip` through the free [HTML5 validator](https://h5validator.appspot.com/adwords/asset):
it is instant and it settles the technical half with certainty.

---

## What's in this repository

```
dist/re-playable.html    The tool. One file, double-click to run.
index.html               The same tool as source, for development.
engine/                  The logic. One small module per job.
docs/                    Where the rules come from, and Google's policy text.
```

`engine/` in brief: `rules` holds every limit and pattern, `inspect` reads a file, `audit` decides
what is wrong, `convert` fixes it, `score` turns findings into a number, `aiscan` runs the optional
review, `zip` packs and unpacks. Each is a few hundred lines and does one thing.

---

## For developers

```bash
node engine/serve.mjs 8099          # run from source at http://localhost:8099/
node engine/test.mjs                # 576 checks, no framework, no network
node engine/build-standalone.mjs    # rebuild dist/re-playable.html
node engine/build-sources.mjs       # rebuild docs/validation-sources.md
```

No dependencies and no build step for normal use. The bundled file is committed so it can be
downloaded and run directly.

**Policy text.** `docs/google-ads-policies.md` holds Google's page captured verbatim, with the URL
and capture date. `engine/build-rubric.mjs` turns it into the prompt mechanically, so nothing is
retyped by hand. To update after Google changes the page, save it again, re-extract into that file,
and re-run the script.

The capture is Google's overview page. Each policy links to a detail page that is not included, so
rules resting on those are marked unsourced in the interface rather than presented as Google's
words.

**Sources.** `docs/validation-sources.md` is generated by `engine/build-sources.mjs` from
`CHECK_SOURCES` in `engine/rules.mjs`. Adding a check without an entry there fails the tests; so
does leaving the generated document stale. Regenerate it in the same commit as the rule.

**Testing against real files.** Drop any playable `.zip` into `fixtures/` and the test suite puts it
through the whole pipeline. None ships with this repository, because a vendor's creative is not ours
to redistribute.
