# Apple Wallet setup

The Private Guest List gives every member a membership card in Apple Wallet. The code is in
`supabase/functions/` and `supabase/migrations/`. This guide covers the one-time Apple and
Supabase setup needed before the cards work on real iPhones.

## How it works

1. A guest scans the table QR code and joins (`join` function). They get a welcome drink code
   and an **Add to Apple Wallet** link.
2. The link (`wallet-pass` function) returns a signed `.pkpass` file. Safari on iPhone opens it
   straight into Wallet.
3. The iPhone registers with Apple's web service (`wallet-service` function) so it can receive updates.
4. When the card changes (a visit, Silver to Gold, a birthday treat), the database queues an update.
   `wallet-push` sends Apple a push, the phone downloads the new card, and iOS shows a lock-screen
   message such as "You're now Gold at Saltline." These pushes cost nothing per message.
5. If the venue's latitude and longitude are set, the card also appears on the lock screen when
   the guest is near the venue.

## 1. Apple Developer account

- Enrol at developer.apple.com/programs (USD 99 a year). Enrol as an organisation if you can;
  it needs a D-U-N-S number and takes longer, but the account then shows your company name.
- Note your **Team ID** (Membership details page). It is `WALLET_TEAM_ID`.

One Pass Type ID covers every venue, because each pass shows the venue's own name, colours and
logo. Venues do not need their own Apple accounts for Wallet cards.

## 2. Pass Type ID and certificate

1. Certificates, Identifiers & Profiles → Identifiers → **+** → **Pass Type IDs**.
   Use something like `pass.com.cloudcove.guestlist`. This is `WALLET_PASS_TYPE_ID`.
2. Open the new identifier → **Create Certificate**. Upload a certificate signing request:

   ```sh
   openssl req -new -newkey rsa:2048 -nodes -keyout pass.key -out pass.csr -subj "/CN=CloudCove Pass"
   ```

3. Download the certificate (`pass.cer`) and convert it to PEM:

   ```sh
   openssl x509 -inform DER -in pass.cer -out pass.pem
   openssl rsa -in pass.key -traditional -out pass-rsa.key
   ```

4. Download Apple's **WWDR intermediate certificate (G4)** from apple.com/certificateauthority
   and convert it:

   ```sh
   openssl x509 -inform DER -in AppleWWDRCAG4.cer -out wwdr.pem
   ```

Keep `pass.key` private. Anyone with it can create cards in your name.

## 3. Supabase secrets

```sh
supabase secrets set \
  WALLET_PASS_TYPE_ID=pass.com.cloudcove.guestlist \
  WALLET_TEAM_ID=ABCDE12345 \
  WALLET_WEB_SERVICE_URL=https://<project-ref>.supabase.co/functions/v1/wallet-service \
  WALLET_SIGNER_CERT="$(cat pass.pem)" \
  WALLET_SIGNER_KEY="$(cat pass-rsa.key)" \
  WALLET_WWDR_CERT="$(cat wwdr.pem)"
```

If the key has a passphrase, also set `WALLET_SIGNER_KEY_PASSPHRASE`.

## 4. Deploy

```sh
supabase db push
supabase functions deploy join --no-verify-jwt
supabase functions deploy wallet-pass --no-verify-jwt
supabase functions deploy wallet-service --no-verify-jwt
supabase functions deploy wallet-push
```

`join`, `wallet-pass` and `wallet-service` are public: guests and iPhones call them without a
Supabase login. They check their own tokens. `wallet-push` only accepts the service role key.

Create a storage bucket called `wallet-assets`. For each venue, upload its artwork under the
venue slug, for example `saltline/icon.png`:

| File | Size (pixels) | Required |
|---|---|---|
| `icon.png`, `icon@2x.png`, `icon@3x.png` | 29, 58, 87 square | Yes. A plain colour square is used if missing |
| `logo.png`, `logo@2x.png`, `logo@3x.png` | up to 160 × 50, 320 × 100, 480 × 150 | Recommended |
| `strip.png`, `strip@2x.png`, `strip@3x.png` | 375 × 123, 750 × 246, 1125 × 369 | Optional, the photo across the card |

## 5. Run pushes every minute

In the SQL editor, with `pg_cron` and `pg_net` enabled:

```sql
select cron.schedule('wallet-push', '* * * * *', $$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/wallet-push',
    headers := jsonb_build_object('Authorization', 'Bearer <service-role-key>')
  );
$$);
```

Store the service role key in Vault rather than pasting it into the job if your team shares the project.

## 6. Test on an iPhone

1. Add a venue: `insert into venues (slug, name, area, type, theme, latitude, longitude) values (...)`.
2. Call `join` from the members app, open the returned `wallet_url` in Safari on an iPhone and add the card.
3. Log three visits for that membership. Within a minute the card should flip to Gold and the
   lock screen should say "You're now Gold at …".

## Known limits and things to verify on first deploy

- **Pushes use a client certificate over HTTP/2** (`Deno.createHttpClient`). Apple requires the
  Pass Type ID certificate for Wallet pushes. If the Supabase Edge Runtime rejects client
  certificates, move `wallet-push` to a small Node function (Vercel works) using the same queue table.
- **Phone numbers are not verified yet.** Anyone can type any number to join. Add a WhatsApp
  one-time code once the WhatsApp Business API is approved.
- **Google Wallet** (Android guests) needs a separate Google Wallet API issuer account. Until then,
  Android guests use the web members app.
- The signing code was tested against OpenSSL with test certificates (signature, hashes, file
  layout). The first real test with Apple's certificates happens on a device after step 3.
