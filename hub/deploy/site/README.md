# Public site edge

This Worker passes the public site and public docs through to the hosted hub while keeping
signed-in application paths on `app.bottega.run`.

The Worker and the hub are released together, hub first. The hub build that knows both
origins must be live before the Worker sends it public traffic; a Worker deployed ahead of
it would show visitors the app's own sign-in behavior at the public address.

1. Deploy the hub with `scripts/deploy/hosted hub`, which passes both origins to the build.
2. Check the app origin: a signed-out visit to its root lands on the public origin.
3. Deploy the Worker from the repository root after authenticating Wrangler:

   ```sh
   wrangler deploy --config hub/deploy/site/wrangler.toml
   ```

4. Check the public origin: the home page, a product page, the docs home and an article load;
   a path that belongs to the app answers with a redirect to the app origin.

To roll back, restore the Worker's previous version first with `wrangler rollback`, then the hub.

Wrangler treats `wrangler.toml` as the whole route list for this Worker: a route that is not
declared there is removed on deploy. Declare every route the Worker must keep.
