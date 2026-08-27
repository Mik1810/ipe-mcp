# M7 viewer and effect matrix

The typed `IPE_EFFECTS` tuple is the single source for Ipe 7.2.30 effect IDs 0–27. `setTransition` creates the native `<effect duration="…" transition="…" effect="ID">` stylesheet entry and points views at it. Effects never replace static views.

The terms are strict: **verified** was exercised on the pinned lane; **degraded** preserves static pages but not the full presentation experience; **ignored** means the behavior is not interpreted; **untested** means no compatibility claim.

| Viewer | Static views | Effects | M7 classification and evidence |
|---|---|---|---|
| IpePresenter 7.2.30 | verified | ignored | Native fixture/PDF navigation is available; IpePresenter source does not interpret PDF transitions. |
| Adobe Acrobat | untested | untested | No pinned Acrobat runtime was installed; no claim is made. |
| Okular | untested | untested | No pinned runtime was exercised. |
| Evince | untested | untested | No pinned runtime was exercised. |
| pdfpc | untested | untested | No pinned runtime was exercised. |
| Browser PDF viewers | degraded | ignored | Static PDF pages are the fallback; transition playback is not claimed. |

`setTransition` returns a viewer warning whenever the selected profile is not verified. In particular, it cannot describe IpePresenter as transition-compatible. Acrobat and specific browser versions remain untested rather than inferred from PDF support.
