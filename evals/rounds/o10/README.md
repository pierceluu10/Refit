# O10: Haiku for plain model swaps

Does Haiku 5.5 fix a plain model swap as well as Sonnet, for less? `haiku-lock.json` holds 6 repos from O2 and O3 whose breaks are only model names, with their original locks. Sonnet already ran them, so each repo compares the same lock and commit. These repos have been seen, so this is a comparison of models and never a score.

A failed check steps up to Sonnet, then Opus, so Haiku can't end an attempt on its own.

**The list changed since those runs:** O2 and O3 ran on the stand-in's list, and this runs on Pierce's. So I rerun Sonnet too, in the same round, instead of comparing to old numbers.
