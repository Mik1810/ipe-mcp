# Initial M1 Viewer Matrix

This is an initial conformance matrix, not a universal compatibility claim. M1 verifies static structure, export, and the presence of PDF transitions; interactive multi-viewer playback remains an M7 gate.

| Viewer/path | Staticness of the 28 views | PDF transitions | M1 status |
|---|---:|---:|---|
| Ipelib/`ipetoipe` 7.2.30 | PASS, 28 PDF pages | Structural PASS, 27 `/Trans` dictionaries | Automatically verified |
| `iperender` 7.2.30 | PASS for sampled views | Does not reproduce transitions | Automatically verified |
| IpePresenter 7.2.30 | Navigable PDF by page/view | No guarantee of effect interpolation | Installed; manual playback not verified |
| Acrobat Reader | Expected from the PDF format | Version/platform-dependent support | Not tested |
| Okular/Evince | Expected for static pages | Partial or ignored support possible | Not tested |
| pdfpc | Expected for static pages | Support not declared by M1 | Not tested |
| Browser viewer | Expected for static pages | Often ignored | Not tested |

## 7.2.30 Enum Covered by the Corpus

| ID | Effect | ID | Effect |
|---:|---|---:|---|
| 0 | Normal | 14 | Glitter left-right |
| 1 | Split horizontal in | 15 | Glitter top-bottom |
| 2 | Split horizontal out | 16 | Glitter diagonal |
| 3 | Split vertical in | 17 | Fly in left-right |
| 4 | Split vertical out | 18 | Fly out left-right |
| 5 | Blinds horizontal | 19 | Fly in top-bottom |
| 6 | Blinds vertical | 20 | Fly out top-bottom |
| 7 | Box in | 21 | Push left-right |
| 8 | Box out | 22 | Push top-bottom |
| 9 | Wipe left-right | 23 | Cover left-right |
| 10 | Wipe bottom-top | 24 | Cover `ECoverLB` (PDF `/Di 270`) |
| 11 | Wipe right-left | 25 | Uncover left-right |
| 12 | Wipe top-bottom | 26 | Uncover top-bottom |
| 13 | Dissolve | 27 | Fade |

The readable name is not serialized: the normative contract is enum ID 0–27 and its corresponding PDF structure. Views remain statically correct even when the viewer ignores `/Trans`.
