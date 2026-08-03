# Literature review — digital reading optimisation (verified)

Auto-synthesised by a fan-out deep-research workflow (109 agents) with **3-vote adversarial verification per claim against primary sources**. Confidence + vote shown. This grounds the paper Introduction/Background; the experiment addresses the OPEN QUESTIONS below.

## Executive summary

For long-form on-screen reading on a consumer display, the empirically-grounded optimum is positive polarity (dark text on a light background) at a contrast comfortably above the saturation point of the contrast-vs-reading-speed curve, with contrast requirements scaled up for smaller and thinner text. The canonical Legge psychophysics framework shows reading speed is governed by two parameters — peak rate and "critical contrast" (where speed halves) — and saturates once contrast exceeds critical, so large reserve contrast neither helps much nor hurts normal readers; low-vision readers need on average 3.9x more contrast. The positive-polarity advantage (better proofreading/acuity, smaller pupils, large effect sizes in normal-vision lab studies) is mechanistically attributed to the higher luminance of light backgrounds constricting the pupil, which sharpens the retinal image; this advantage is real but ambient-light-dependent and markedly smaller in older adults, and dark mode can win in dark ambients or for light-sensitive users. For target metrics, WCAG 2.x's single fixed ratio (e.g. 4.5:1) is a poor reading-performance predictor — especially for dark colors/dark mode — and APCA's perceptually-based Lc scale with a font-size/weight matrix (Lc 90 preferred / Lc 75 minimum for body text) better operationalizes the vision-science fact that high-spatial-frequency (small/thin) text needs more contrast. The consensus critical print size is ~0.2 deg x-height (≈9 pt Times at 40 cm), below which reading speed falls sharply.

## Verified findings

### 1. The contrast-vs-reading-speed function is governed by two parameters — peak reading rate and 'critical contrast' (the contrast at which reading speed drops to half its maximum) — producing a saturating high-contrast plateau where contrast above critical yields little additional speed for normal readers; reading also tolerates increasing blur/loss of high spatial frequencies until letter recognition becomes contrast-sensitive, at which point the visual span shrinks and reading slows.
_confidence: **high**, vote 3-0_

> Rubin & Legge (1989, Vision Research, PMID 2788957): 'Reading performance was characterized by two parameters: peak reading rate is the reading rate at maximum contrast, and critical contrast is the contrast at which reading rate drops to half its maximum value.' Companion Paper V shows reading rate decreased <2x for a 10x contrast reduction at 1deg letters — a tolerant plateau above critical contrast. Kwon & Legge (2012, PMC3653576): 'Reading can tolerate increasing blur until a point is reached for which letter recognition becomes sensitive to letter contrast. Under these conditions, the visual span shrinks in size and reading slows down.' Critical cutoff frequencies, visual-span size, and contrast-invariant letter recognition cluster near ~1.4 cycles/letter. Implication for tuning: target contrast at or modestly above critical contrast; further increases give diminishing returns for n

- https://legge.psych.umn.edu/sites/legge.psych.umn.edu/files/2020-08/psychophysics_of_reading._vi._the_role_of_contrast_in_low_vision_rubin_legge_1989.pdf
- https://www.ncbi.nlm.nih.gov/pmc/articles/PMC3653576/

### 2. Low-vision readers require substantially more contrast than normal readers — in 16 of 19 cases critical contrast was higher, averaging 3.9x higher — indicating decreased tolerance to contrast reduction; this is the basis for the low-vision/dyslexia difference and for per-individual calibration.
_confidence: **high**, vote 3-0_

> Rubin & Legge (1989, Vision Research 29(1):79-91, PMID 2788957): 'In 16 of 19 cases, critical contrasts were higher for low-vision observers than for normal observers (averaging 3.9 times higher), indicating a decreased tolerance to contrast reduction.' Critical contrast was tightly correlated with letter contrast sensitivity (r=0.87). Seminal, uncontested foundational result.

- https://legge.psych.umn.edu/sites/legge.psych.umn.edu/files/2020-08/psychophysics_of_reading._vi._the_role_of_contrast_in_low_vision_rubin_legge_1989.pdf

### 3. Required contrast is spatial-frequency-dependent: smaller and thinner (higher-spatial-frequency) text has lower perceived contrast and needs a larger physical lightness difference, because the human contrast sensitivity function falls off at high spatial frequencies (CSF peaks ~2-5 cpd; small acuity letters occupy ~18-30 cpd where sensitivity plummets). This is the vision-science basis for APCA's font-size/weight matrix.
_confidence: **high**, vote 3-0_

> APCA WhyAPCA: 'Smaller, thinner letters or graphics lowers the perceived contrast ... the lightness/darkness difference between text and background color must be increased to compensate for small thin fonts.' APCA in a Nutshell: 'design flexibility is achieved by relaxing contrast for large non-text elements ... (i.e. lower spatial frequencies use lower contrasts).' Corroborated by CSF literature (NCBI NBK219042) and Legge's reading psychophysics (peak tuning ~1.7-3.4 c/letter foveally, PMC2849799). APCA's matrix operationalizes this (e.g. Lc 60 requires >=24px @400 but only 16px @700).

- https://git.apcacontrast.com/documentation/WhyAPCA.html
- https://git.apcacontrast.com/documentation/APCA_in_a_Nutshell.html

### 4. APCA reports contrast as a perceptually-based lightness/darkness value Lc (0 to 105+) designed so that halving/doubling Lc halves/doubles perceived contrast, with numeric body-text thresholds: Lc 90 preferred for fluent body text (font >=14px/weight 400) and Lc 75 minimum for body text (>=18px/400, or 16px/500, 14px/700). This perceptual-uniformity and size-awareness is a design property WCAG 2.x ratios lack.
_confidence: **high**, vote 3-0_

> APCA WhyAPCA: 'Lc 90 - Preferred level for fluent text and columns of body text with a font no smaller than 14px/weight 400 (normal) ... Lc 75 - The minimum level for columns of body text with a font no smaller than 18px/400.' APCA in a Nutshell: 'Halving or doubling the APCA value relates to halving or doubling the perceived contrast'; scale pivots 'near the point where the CS curve flattens due to contrast constancy.' Corroborated by 2026 secondary guides (66colorful, accessibilitychecker, Myndex/SAPC-APCA). CAVEAT: the perceptual-uniformity property is largely the algorithm author's (Somers/Myndex) characterization; APCA remains a WCAG 3 candidate/draft and rigorous independent proof that Lc is strictly proportional to perceived contrast is incomplete — cite as APCA's design property, not settled psychophysical fact.

- https://git.apcacontrast.com/documentation/WhyAPCA.html
- https://git.apcacontrast.com/documentation/APCA_in_a_Nutshell.html

### 5. WCAG 2.x's single-number ratio (4.5:1 / 3:1) is not a valid blanket reading-performance target: it ignores use case, font size and thickness, and (using the symmetric (L1+0.05)/(L2+0.05) formula with a single flare constant) overstates contrast for near-black colors, so nominally-passing pairs can be functionally unreadable — making it unsuitable for dark-mode guidance.
_confidence: **high**, vote 3-0_

> APCA WhyAPCA: 'No single figure such as 4.5:1 or 3:1 can be used as a blanket target ... without considering the use case, size, thickness, etc.' APCA in a Nutshell: WCAG 2.x 'overstates contrast for dark colors to the point that 4.5:1 can be functionally unreadable when one of the colors in a pair is near black' and 'cannot be used for guidance designing dark mode.' Independent corroboration: W3C low-vision-a11y-tf #131 testing found 27.9% of WCAG 2 passes incorrect (55.7% false passes when one color is black); a Cambridge analysis of ~5,000 colors found ~47% of WCAG-passing pairs should fail for readability; W3C selected APCA as the WCAG 3 candidate method. CAVEAT: 'invalid' is slightly stronger than the consensus framing ('insufficient/flawed'); WCAG 2.x remains the legal/compliance floor and the primary APCA source is self-interested, though the technical critique is corroborated and

- https://git.apcacontrast.com/documentation/WhyAPCA.html
- https://git.apcacontrast.com/documentation/APCA_in_a_Nutshell.html

### 6. There is a robust 'positive polarity advantage': dark text on a light background yields better reading/proofreading performance and visual acuity than light text on a dark background, with no speed-accuracy trade-off; in normal-vision lab studies effect sizes are large (proofreading dz=0.77, reading-rate dz=0.68; acuity d=2.17 in younger adults), 82% of participants prefer positive polarity, and dark-on-light is recommended regardless of age.
_confidence: **high**, vote 3-0_

> Piepenbrock, Mayr & Buchner (2014, Ergonomics 57(11), PMID 25135324): positive polarity gave better proofreading accuracy (t(34)=4.54, dz=0.77) and higher reading rate (t(34)=4.04, dz=0.68); 82/18 preference split. Piepenbrock et al. (2013, Ergonomics 56(7)): acuity advantage for younger (d=2.17) and older (d=0.58) adults, 'recommended independent of observer's age'; proofreading better for both ages (F(1,165)=9.92, p<0.01) with NO speed-accuracy trade-off (reading rate F(1,165)=0.16, p=0.69). A 2025 mixed-reality study replicates the advantage. QUALIFICATIONS (bound, not refute): the advantage shrinks/disappears when display luminance is equalized between polarities; it is ambient-dependent (only nominal under bright ambient light, per Buchner & Baumgartner 2007; Dobres et al. reframe it as a small 'negative-polarity disadvantage'); markedly smaller in older adults; one recent study fou

- https://pubmed.ncbi.nlm.nih.gov/25135324/
- https://www.psychologie.hhu.de/fileadmin/redaktion/Oeffentliche_Medien/Fakultaeten/Mathematisch-Naturwissenschaftliche_Fakultaet/Psychologie/AAP/Publikationen/in_press/Piepenbrock-in_press-Smaller_pupil_size_and_better.pdf
- https://www.researchgate.net/publication/236662424_Positive_display_polarity_is_advantageous_for_both_younger_and_older_adults
- https://www.sciencedirect.com/science/article/pii/S0042698919302123

### 7. The positive-polarity advantage is mechanistically driven by the higher luminance of light-background displays: brighter displays constrict the pupil (positive 2.09 mm vs negative 3.65 mm, dz=2.96; ambient illumination at the eye was >30x higher in positive conditions), which reduces spherical aberration and increases depth of field, sharpening the retinal image; within-study, performance increased as pupil size decreased. This is the 'display luminance hypothesis' — a luminance/optics mechanism, not familiarity.
_confidence: **high**, vote 3-0 (mechanism framing 2-1 on two sub-claims)_

> Piepenbrock et al. (2014): pupil 2.09 mm (positive) vs 3.65 mm (negative), t(34)=-17.49, dz=2.96; positive gave 118.4 lx vs 2.7 lx at the eye. Within-study regressions: proofreading accuracy increased with decreasing pupil (b=-0.24, t=-6.04) and reading rate (b=-2.12, t=-5.12). Piepenbrock et al. (2013): 'ambient illumination at the participants' eye position was more than 30 times higher in the positive ... The brighter display leads to a greater pupillary contraction that, in turn, reduces the effects of spherical aberrations ... and increases the depth of field'; 'Variables other than display luminance - such as familiarity - seem to be of minor (or even no) relevance.' Optical sub-mechanism independently established (depth of field doubles as pupil diameter halves; NCBI StatPearls). CAVEAT: framed as a hypothesis 'compatible with' the data; pupil was measured not manipulated (correla

- https://www.psychologie.hhu.de/fileadmin/redaktion/Oeffentliche_Medien/Fakultaeten/Mathematisch-Naturwissenschaftliche_Fakultaet/Psychologie/AAP/Publikationen/in_press/Piepenbrock-in_press-Smaller_pupil_size_and_better.pdf
- https://pubmed.ncbi.nlm.nih.gov/25135324/
- https://www.researchgate.net/publication/236662424_Positive_display_polarity_is_advantageous_for_both_younger_and_older_adults

### 8. Text-background color combination measurably modulates the eye's accommodative (focusing) and pupillary dynamics during reading: positive polarities show smaller pupil sizes but greater accommodative-response variability, indicating a trade-off in focusing stability even as the smaller pupil sharpens the image.
_confidence: **medium**, vote 3-0_

> Jiménez et al. (2019/2020, Vision Research, S0042698919302123): 20 healthy young adults read fourteen 2-min passages on an LCD with continuous binocular open-field autorefractometry. 'The text-background color combination modulates the accommodative and pupillary dynamics during a 2-min reading task'; 'positive polarities were associated with more variability of the accommodative response and smaller pupil sizes.' Single primary source for the accommodative-variability finding (hence medium); the smaller-pupil finding corroborates the broader polarity literature. This nuances the positive-polarity recommendation: smaller/sharper pupil but less stable focusing.

- https://www.sciencedirect.com/science/article/pii/S0042698919302123

### 9. Under negative polarity (text on black) — relevant to dark-mode and low-ambient reading — text color significantly affects visual fatigue (ranked worst-to-best: red > green > blue > white > yellow), and increasing ambient illumination from 0 to 10 lux significantly reduces visual fatigue (p=0.001), showing an ambient-dependent benefit for dark-mode reading. The hue ranking likely tracks text-background luminance contrast more than hue per se.
_confidence: **medium**, vote 2-1_

> Liu/Wang et al. (2024, Sensors 24(11):3516, PMC11175232; n=50, Tobii eye-tracker blink rate + pupil accommodation + subjective questionnaire): fatigue ranking 'red text > green text > blue text > white text > yellow text'; yellow minimized and red maximized fatigue; '0 lux vs 10 lux was statistically significant (p=0.001).' CAVEATS: tested only near-dark ambient (0/5/10 lux, modeling nighttime/HUD use), symbol-recognition not prose; the paper itself reports a significant negative correlation between luminance contrast and fatigue, and pure red/blue have low luminance on black — so the hue ranking likely reflects luminance contrast (a confound noted by reviewers). Single primary source; one dissenting vote on each sub-claim; does NOT establish dark mode superiority over light mode generally.

- https://pmc.ncbi.nlm.nih.gov/articles/PMC11175232/

### 10. The consensus critical print size (CPS) for normally sighted readers is ~0.2 deg x-height (range ~0.15-0.3 deg across individuals/fonts/methods), below which reading speed declines sharply; at 40 cm with Times New Roman this 0.2 deg equals a 9-point body size. Reading speed is constant across the ~0.2-2.0 deg 'fluent range', and CPS rises with age (to ~0.3 deg+ in the elderly) and correlates with acuity — the basis for MNREAD-style critical-print-size measurement.
_confidence: **high**, vote 3-0_

> Legge & Bigelow (2011, Journal of Vision review): 'a consensus value for the critical print size for normally sighted readers is 0.2 deg x-height (Legge, 2007)' and 'At a viewing distance of 40 cm ... Times New Roman, with an x-height fraction of 0.45 and a visual x-height of 0.2 deg, is equivalent to a physical body size of 9 points.' Arithmetic check: 9 pt x 0.45 = 1.43 mm x-height; 57.3 x 1.43/400 = 0.205 deg at 40 cm. CPS ~= 12 arcmin ~= 0.38 logMAR. MNREAD baseline (Calabrese et al. 2016) shows CPS rising from ~0.2 deg (young) to ~0.3 deg+ (~81 yr); across 19 fonts adjustment <=0.17 logMAR. The 0.15 deg lower bound is hedged and not pinned to a specific figure but falls within young-reader/font variability.

- https://jov.arvojournals.org/article.aspx?articleid=2191906

## Refuted (do NOT cite)

- Below a cutoff of ~1.47 CPL, letter recognition becomes contrast-dependent — the visual system requires more suprathreshold contrast to recognize letters, which is the mechanism by which reading slows.

## Open questions — what THIS experiment answers

- What is the specific quantitative critical contrast in Michelson terms for normal readers (the often-cited ~10% figure from Legge Psychophysics of Reading V), and exactly how much, if at all, does suprathreshold contrast ABOVE saturation help or hurt (halation/glare/astigmatism limits) on a high-luminance glossy display?
- How does rendered contrast on the specific 2022 MacBook Air M2 (glossy LED-backlit IPS, ~500 nits, P3, 227 ppi, True Tone) diverge from the digital APCA/WCAG spec under realistic ambient lighting due to veiling glare and reflections, and what target Lc/Michelson should one set at the source to achieve a given perceived contrast at the retina?
- What are the empirically-optimal interacting typography parameters for long-form screen reading (x-height, font weight, measure ~45-75 chars, line-height/leading, letter and word spacing), and how do they trade off against the size-dependent contrast requirement encoded by APCA?
- Is there controlled evidence that adaptive methods (ambient-light-sensor brightness, Apple True Tone, per-user calibration, DICOM GSDF perceptual linearization) actually improve reading speed/comfort, and what is the simplest valid single-person protocol combining MNREAD/critical-print-size measurement with phone-camera photographic extraction of rendered text/background luminance and edge point-s

## Caveats

Verification scope vs. coverage: the verified claims strongly cover contrast metrics (1, APCA vs WCAG), the contrast-vs-reading-speed function (2, with the low-vision difference), and polarity (3, the strongest-evidenced topic — 6 of 10 findings). They cover the contrast sensitivity function (4) and critical print size / MNREAD (parts of 5 and 8) more thinly, and do NOT directly substantiate several specific items in the research question: (a) the often-cited ~10% Michelson critical-contrast figure from Legge Paper V is not among the verified claims (the canonical two-parameter framing is, but not the specific numeric value); (b) APCA's polarity-asymmetric Stevens exponents are referenced only generically, not with specific exponent values; (c) detailed TYPOGRAPHY optima (x-height, optimal measure ~45-75 chars, line-height/leading, letter/word spacing) are NOT covered by any verified claim; (d) DISPLAY-SPECIFIC factors for the MacBook Air M2 (glossy IPS, ~500 nits, P3, 227 ppi, True Tone, veiling glare) are NOT covered; (e) ADAPTIVE approaches (ambient-light-sensor brightness, True Tone evidence, DICOM GSDF perceptual linearization) are NOT covered; (f) image-based 'rendered contrast' measurement from phone-camera photos (extracting text/background luminance, veiling glare, edge PSF/halation) and practical phone-camera + lux-meter protocols on a MacBook are NOT covered. Source-quality notes: the APCA documentation (apcacontrast.com / Myndex) is a self-interested primary source — its technical critiques of WCAG 2.x are independently corroborated by W3C task-force testing, but its perceptual-uniformity and halving/doubling claims are author characterizations of a still-draft WCAG 3 candidate, not independently validated psychophysics. Time-sensitivity: APCA/WCAG 3 is an evolving draft (thresholds and the Lc matrix could change before standardization); WCAG 2.x remains the legal/compliance benchmark regardless of its readability limitations. Effect-size caveat: the headline polarity effect sizes (e.g. dz=2.96 for pupil size) are amplified by experimental designs that maximized contrast and deliberately let luminance differ between polarities, so they overstate the advantage relative to luminance-matched real-world comparisons; the polarity advantage is ambient-dependent and modest-to-absent under bright ambient light. The refuted claim (a specific ~1.47 cycles-per-letter cutoff as the mechanism for slowing) failed verification, so do not cite a precise CPL cu

## Sources

- {'url': 'https://legge.psych.umn.edu/sites/legge.psych.umn.edu/files/2020-08/psychophysics_of_reading._vi._the_role_of_contrast_in_low_vision_rubin_legge_1989.pdf', 'quality': 'primary', 'angle': 'broad/primary — contrast metrics & reading-speed function', 'claimCount': 5}
- {'url': 'https://git.apcacontrast.com/documentation/WhyAPCA.html', 'quality': 'primary', 'angle': 'broad/primary — contrast metrics & reading-speed function', 'claimCount': 5}
- {'url': 'https://www.psychologie.hhu.de/fileadmin/redaktion/Oeffentliche_Medien/Fakultaeten/Mathematisch-Naturwissenschaftliche_Fakultaet/Psychologie/AAP/Publikationen/in_press/Piepenbrock-in_press-Smaller_pupil_size_and_better.pdf', 'quality': 'primary', 'angle': 'broad/primary — contrast metrics & reading-speed function', 'claimCount': 5}
- {'url': 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC3653576/', 'quality': 'primary', 'angle': 'broad/primary — contrast metrics & reading-speed function', 'claimCount': 5}
- {'url': 'https://pubmed.ncbi.nlm.nih.gov/25135324/', 'quality': 'primary', 'angle': 'academic/vision-science — polarity & contrast sensitivity function', 'claimCount': 3}
- {'url': 'https://www.sciencedirect.com/science/article/pii/S0042698919302123', 'quality': 'primary', 'angle': 'academic/vision-science — polarity & contrast sensitivity function', 'claimCount': 4}
- {'url': 'https://www.researchgate.net/publication/236662424_Positive_display_polarity_is_advantageous_for_both_younger_and_older_adults', 'quality': 'primary', 'angle': 'academic/vision-science — polarity & contrast sensitivity function', 'claimCount': 5}
- {'url': 'https://pmc.ncbi.nlm.nih.gov/articles/PMC11175232/', 'quality': 'primary', 'angle': 'academic/vision-science — polarity & contrast sensitivity function', 'claimCount': 5}
- {'url': 'https://git.apcacontrast.com/documentation/APCA_in_a_Nutshell.html', 'quality': 'primary', 'angle': 'academic/vision-science — polarity & contrast sensitivity function', 'claimCount': 4}
- {'url': 'https://www.ncbi.nlm.nih.gov/books/NBK219042/', 'quality': 'secondary', 'angle': 'academic/vision-science — polarity & contrast sensitivity function', 'claimCount': 4}
- {'url': 'https://jov.arvojournals.org/article.aspx?articleid=2191906', 'quality': 'primary', 'angle': 'typography/standards — measure, leading, x-height interacting with contrast', 'claimCount': 5}
- {'url': 'https://www.sciencedirect.com/science/article/pii/S0042698919301087', 'quality': 'primary', 'angle': 'typography/standards — measure, leading, x-height interacting with contrast', 'claimCount': 0}
- {'url': 'https://pmc.ncbi.nlm.nih.gov/articles/PMC3429790/', 'quality': 'primary', 'angle': 'typography/standards — measure, leading, x-height interacting with contrast', 'claimCount': 3}
- {'url': 'https://eric.ed.gov/?id=EJ749012', 'quality': 'secondary', 'angle': 'typography/standards — measure, leading, x-height interacting with contrast', 'claimCount': 4}
- {'url': 'https://baymard.com/blog/line-length-readability', 'quality': 'secondary', 'angle': 'typography/standards — measure, leading, x-height interacting with contrast', 'claimCount': 5}
- {'url': 'https://www.uxpin.com/studio/blog/optimal-line-length-for-readability/', 'quality': 'secondary', 'angle': 'typography/standards — measure, leading, x-height interacting with contrast', 'claimCount': 5}
- {'url': 'https://www.sciencedirect.com/science/article/abs/pii/S0747563214004750', 'quality': 'primary', 'angle': 'display/practitioner — glossy LED IPS under ambient light', 'claimCount': 5}
- {'url': 'https://pmc.ncbi.nlm.nih.gov/articles/PMC3044073/', 'quality': 'primary', 'angle': 'display/practitioner — glossy LED IPS under ambient light', 'claimCount': 5}
- {'url': 'https://www.nist.gov/publications/diffuse-reflectance-and-ambient-contrast-measurement-methods-flat-panel-displays', 'quality': 'primary', 'angle': 'display/practitioner — glossy LED IPS under ambient light', 'claimCount': 3}
- {'url': 'https://cdn.standards.iteh.ai/samples/57992/bddfd91165b444f6b9815a6993feadc5/ISO-9241-303-2011.pdf', 'quality': 'primary', 'angle': 'display/practitioner — glossy LED IPS under ambient light', 'claimCount': 5}
- {'url': 'https://mnread.umn.edu/reading-measures', 'quality': 'unreliable', 'angle': 'methods/measurement — protocols to tune contrast per individual & camera-based rendered contrast', 'claimCount': 0}
- {'url': 'https://pmc.ncbi.nlm.nih.gov/articles/PMC10700427/', 'quality': 'primary', 'angle': 'methods/measurement — protocols to tune contrast per individual & camera-based rendered contrast', 'claimCount': 3}
- {'url': 'https://sid.onlinelibrary.wiley.com/doi/10.1002/jsid.70073', 'quality': 'unreliable', 'angle': 'methods/measurement — protocols to tune contrast per individual & camera-based rendered contrast', 'claimCount': 0}
- {'url': 'https://www.energystar.gov/sites/default/files/asset/document/NEEA%20Method%20for%20Measuring%20TV%20Screen-Average%20Dynamic%20Luminance%20with%20a%20Camera%20Photometer.pdf', 'quality': 'primary', 'angle': 'methods/measurement — protocols to tune contrast per individual & camera-based rendered contrast', 'claimCount': 5}
- {'url': 'https://legge.dl8.umn.edu/sites/legge.psych.umn.edu/files/2020-08/obrien_mansfield_legge_2000_the_effect_of_contrast_on_reading_speed_in_dyslexia.pdf', 'quality': 'primary', 'angle': 'contrarian/recent controversies', 'claimCount': 5}
- {'url': 'https://adrianroselli.com/2026/04/wcag3-contrast-as-of-april-2026.html', 'quality': 'blog', 'angle': 'contrarian/recent controversies', 'claimCount': 4}
---
## Methodology sources — verified (2nd research pass; synthesis crashed but verification succeeded)
Salvaged from the failed-synthesis run (108 agents; claims 3-vote verified verbatim against primaries).
These validate the **camera/physical-display** methodology — the dimension the one-click canvas study
cannot reach — so they ground the optional camera *extension*, not the primary screenshot study.

- **CameraVDP** — Cai, Wanat & Mantiuk, *SIGGRAPH Asia 2025*, arXiv:2509.08947, DOI 10.1145/3757377.3763825, code `github.com/gfxdisp/CameraVDP`. Camera-based **perceptual display assessment with uncertainty estimation** (derives a theoretical upper bound for detection). → the SOTA camera-measurement + uncertainty framework.
- **Hertel & Penczek 2020**, "Evaluating Display Reflections in Reflective Displays and Beyond," *Information Display* 36(3):14–24 (SID), DOI 10.1002/msid.1099. **Two-component reflection model**: diffuse L_refl ∝ illuminance/π + a specular term. → the ambient-contrast formula used in the camera extension.
- **Saw/Diaz et al. 2023**, "Development of a Low-Cost Luminance Imaging Device with Minimal Equipment Calibration," *Buildings* 13(5):1266 (MDPI). → validates a **phone camera as a luminance meter** + calibration procedure.
- **He et al. 2025**, "Measurement and characterization of the halo effect for mini-LED backlit LCDs," *Optics Express* 33(5):12204–12216, DOI 10.1364/OE.557308 (PMID 40798822); + Xinyu et al. 2024, *J. SID*. → a validated **mini-LED halo/bloom** metric (relevant to the iPad-Pro mini-LED).

**Implication (honest):** the verified methodology literature is strongest exactly where the one-click
canvas/screenshot approach is blind — ambient reflection, mini-LED halo, on-glass luminance. So the
design is **two-tier**: (1) the one-click canvas instrument = rigorous, reproducible RASTERISATION study
(primary); (2) an optional, literature-grounded **camera extension** (Hertel reflection model + phone
luminance imaging + CameraVDP uncertainty + mini-LED-halo metric) for the physical-display layer.
