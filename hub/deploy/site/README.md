# Public site edge

This Worker passes the public site and public docs through to the hosted hub while keeping
signed-in application paths on `app.bottega.run`.

Deploy from the repository root after authenticating Wrangler:

```sh
wrangler deploy --config hub/deploy/site/wrangler.toml
```
