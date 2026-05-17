# Setting up YouTube on Playbill

YouTube on Playbill uses **your own** Google Cloud project — not ours. This is
the same approach the Kodi YouTube add-on takes. There's no shared API key, no
verification process you have to wait on, and you control your own quota.

It's a one-time setup that takes about 10 minutes. After that, YouTube on
Playbill just works.

> **Why this approach?** Google's "YouTube on TV" partnerships are reserved for
> companies that ship at OEM scale (Roku, Samsung, Apple, Sony, etc.). Smaller
> third-party clients aren't eligible. Rather than ask you to wait years for a
> partnership that won't come, we let you run your own one-user Google project
> against the public YouTube Data API. Quota is yours. Privacy is yours.

---

## What you'll need

- A **Google account** (Gmail is fine).
- A web browser on your phone or laptop. **Not your Playbill** — its built-in
  browser would work but the steps below are easier on a regular screen.
- About 10 minutes.

You won't be charged anything. The Google Cloud project you'll create has a
free tier that's more than enough for personal YouTube use.

---

## Steps

### 1 · Create a Google Cloud project

1. Go to <https://console.cloud.google.com/>.
2. Sign in with your Google account.
3. At the very top of the page, click the project picker (next to the
   "Google Cloud" logo). A modal opens.
4. Click **"NEW PROJECT"** in the top-right of the modal.
5. **Project name:** anything you want. Suggestion: `My Playbill`.
6. Click **CREATE**.
7. Wait ~30 seconds for the project to provision. The project picker will
   refresh and show your new project as selected.

### 2 · Enable the YouTube Data API v3

1. In the left navigation, click **APIs & Services → Library**.
   (If you don't see the side nav, click the ☰ icon in the top-left.)
2. In the search box, type `YouTube Data API v3`.
3. Click the **YouTube Data API v3** result.
4. Click the **ENABLE** button. Wait ~10 seconds.

### 3 · Configure the OAuth consent screen

1. Left nav: **APIs & Services → OAuth consent screen**.
2. **User Type:** select **External**, then click **CREATE**.
3. Fill in the required fields:
   - **App name:** anything you want (e.g., `My Playbill`).
   - **User support email:** your Gmail address.
   - **Developer contact information:** your Gmail address.
4. Click **SAVE AND CONTINUE** through the remaining screens until you're
   back at the OAuth consent screen overview. You don't need to add scopes
   or modify the other settings.

### 4 · Add yourself as a Test User

Still on the OAuth consent screen page:

1. Find the **Test users** section. Click **+ ADD USERS**.
2. Type the Gmail address you'll be signing into YouTube with. (This can be
   the same as the developer email, or a different family Gmail account, or
   both — you can add up to 100 test users.)
3. Click **SAVE**.

> 🛈 If you skip this step, you'll see a "Google hasn't verified this app"
> warning when you sign in. You can click **Advanced → Go to (unsafe)** to
> proceed, but it's nicer to just add yourself here.

### 5 · Create the OAuth 2.0 Client ID

1. Left nav: **APIs & Services → Credentials**.
2. Click **+ CREATE CREDENTIALS** near the top, then choose **OAuth client ID**.
3. **Application type:** select **TVs and Limited Input devices**.
4. **Name:** anything (e.g., `Playbill TV client`). Click **CREATE**.
5. A modal pops up with your **Client ID** and **Client secret**.

   **Leave that modal open.** You'll copy both values into Playbill in the
   next step.

> Playbill talks to YouTube using your OAuth tokens once you're signed in,
> so a separate "API key" credential is **not** required — you can skip
> the API key credential type entirely.

### 6 · Paste the two values into Playbill

You should now have:
- A **Client ID** (long string ending in `.apps.googleusercontent.com`)
- A **Client secret** (~24-character string)

Two ways to give these to Playbill — pick whichever is more convenient:

**From the Headwaters PWA on your phone:**
1. Open the PWA, tap the **Playbill** nav icon.
2. Tap the **YouTube** tab.
3. Paste both values into the form.
4. Tap **Save**.
5. Tap **Sign in**. A 6-digit code appears. On your phone (or any other
   device), open <https://youtube.com/activate> and enter that code, then
   sign in with the Gmail account you added as a Test User in step 4.
6. After Google says "device connected," Playbill flips to "Signed in as
   <your channel name>."

**From the Playbill itself (Electron app on the Q6A):**
1. Open the Playbill app, navigate to **Settings → Sources → YouTube**.
2. Same paste-and-save flow as above.

You're done. YouTube under **Sources** in Playbill now works.

---

## What to expect afterward

### Quota

Google gives each Cloud project **10,000 "units" per day** of YouTube Data API
quota. For reference:

| Operation                  | Cost   |
|----------------------------|--------|
| Search                     | 100 units |
| Browse a channel page      | ~5 units |
| Load a playlist            | ~5 units |
| Start playback             | 0 units (stream resolution uses yt-dlp, no API call) |

A typical viewing day is 100–500 units. You'd need to do hundreds of
searches a day to run out. If you ever hit the limit:

- New searches stop working until the quota resets at midnight Pacific
  time. Already-loaded pages and playback continue to work.
- You can request a quota increase from Google (free, takes ~1 business
  day) — visit
  <https://console.cloud.google.com/iam-admin/quotas> and filter for
  "YouTube Data API."

### Re-consent every 7 days

While your OAuth project is in **Testing** mode (which is where it stays —
you don't need to publish it), Google requires the user to re-consent every
**7 days**. In practice this means about once a week, Playbill's YouTube
tab will show "Session expired — please sign in again." Tap **Sign in** and
go through the 6-digit code flow once more.

To remove the 7-day re-consent:
- The **only** way is to put the OAuth project into "Production" status and
  submit it for verification — which would require Google to approve it,
  which they won't because they don't verify TV-style YouTube clients.
- So the 7-day re-consent is unavoidable. It's the same trade-off every
  third-party YouTube client lives with.

### Multiple Gmail accounts

You can add up to **100 test users** in step 4. If your family has separate
Gmail accounts and you want each of them to be able to sign in (subscriptions,
watch history, etc.), add all their emails as test users on the same OAuth
project, then sign in/out from Playbill's YouTube tab as needed.

### Multiple Playbills

If you have more than one Playbill on the rig, **each Playbill needs its own
credential entry** — you paste the same two values into each. The quota is
shared across all of them because they share one Google Cloud project.

---

## Troubleshooting

**"This app isn't verified" / "Google hasn't verified this app"**
You skipped step 4 (adding yourself as a Test User), or you're signing in
with a different Gmail than the one you added as a Test User. Go back to
step 4 and add the email you're trying to sign in with.

**"Sign in failed: invalid_grant" / "Token expired"**
The 7-day re-consent window elapsed. Tap **Sign in** again and complete the
device-code flow.

**"Quota exceeded"**
You burned through 10,000 units in one day (rare). Wait until midnight
Pacific time or request a quota increase per the link above.

**"Invalid client" / "Client ID not found"**
Double-check the Client ID was pasted in full and ends in
`.apps.googleusercontent.com`. The Cloud Console truncates the display in
some views; click the row in the Credentials list to see the full value.

**The YouTube tab in Playbill says "Configure your Google Cloud credentials"
but I already pasted them**
Each Playbill stores its own credentials. If you set them up on Playbill A
and a different Playbill B shows the same message, paste the values into
Playbill B too.

---

## What's stored where

| Where               | What                                              |
|---------------------|---------------------------------------------------|
| Google Cloud Console (yours) | OAuth client and your project quota |
| Playbill, file mode 0600 | `~/.config/trailcurrent-playbill/sources/youtube/client.json` — clientId, clientSecret |
| Playbill, file mode 0600 | `~/.config/trailcurrent-playbill/sources/youtube/tokens.json` — OAuth refresh + access tokens after sign-in |
| Headwaters (cloud)  | Nothing. We don't see, touch, or sync any of this. |

Your credentials never leave your rig. The Playbill controller talks
directly to Google with them; no proxy through Headwaters or any other
service.

---

## Why we have to do it this way

The short version: Google's API services policy explicitly bans
"duplicating YouTube's experience" via the public YouTube Data API. The
verification process for an app like Playbill — a TV-style YouTube client
that isn't an officially-partnered TV platform — gets rejected. This isn't
unique to us: Kodi's YouTube addon, Plex's third-party YouTube channels,
FreeTube, ViewTube, and every other open-source YouTube client lives under
the same constraint.

The "bring your own Google Cloud project" approach sidesteps the issue
entirely. From Google's perspective, each Playbill owner is a developer
building a one-user app for themselves. There's no shared client to verify,
no quota to share, no central app for policy enforcement to flag.

It's clunky, but it's the only path that doesn't rely on either:
- A Smart-TV-platform partnership we'd need to be Sony-sized to negotiate, or
- An ad-stripping reimplementation that violates YouTube's terms of service
  and breaks every few months.

Most users finish this setup in 10 minutes and never think about it again.
