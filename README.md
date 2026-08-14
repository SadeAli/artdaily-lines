# Steady Lines — ghost straight strokes

A daily line-confidence drill: two checkpoint dots appear, you press on A and
pull **one** straight stroke to B. Six strokes per round (~40 seconds), longer
as the round goes on, and your last two attempts stay faintly ghosted on the
page — ghosting lines is the classic studio warm-up this game trains.

**Scoring** is pure geometry: straightness = 100 × (1 − RMS drift from the
ideal segment ÷ stroke length ÷ 0.055), minus up to 20 points for missing the
endpoint dots (the first 24 px of combined miss are free). Round score is the
mean of the six strokes; after each one the ideal line is overlaid in mint so
you see exactly where you drifted.

## Run it

No build step, no dependencies:

```sh
python3 -m http.server 8080
# then visit http://localhost:8080
```

Part of [Art Daily](https://artdaily.sadeali.com/), a
[SadeAli](https://sadeali.com/) experiment — more at
[sadeali.com](https://sadeali.com/).
