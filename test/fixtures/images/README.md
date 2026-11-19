Small images for the structural image checks, made with the bundled FFmpeg:

```
ffmpeg -f lavfi -i "testsrc=size=64x48:rate=1" -frames:v 1 -c:v libwebp -lossless 0 -quality 80 lossy.webp
ffmpeg -f lavfi -i "testsrc=size=64x48:rate=1" -frames:v 1 -c:v libwebp -lossless 1 lossless.webp
ffmpeg -f lavfi -i "testsrc=size=64x48:rate=1,format=rgba,colorchannelmixer=aa=0.5" -frames:v 1 -c:v libwebp -lossless 0 -pix_fmt yuva420p alpha.webp
ffmpeg -f lavfi -i "testsrc=size=32x32:rate=4" -frames:v 3 -c:v libwebp -loop 0 animated.webp
ffmpeg -f lavfi -i "testsrc=size=40x30:rate=1" -frames:v 1 sample.png
ffmpeg -f lavfi -i "testsrc=size=40x30:rate=1" -frames:v 1 -q:v 4 sample.jpg
```

`sample.png` carries a `pHYs` chunk and `sample.jpg` an encoder comment; tests strip them
to build the clean variants.
