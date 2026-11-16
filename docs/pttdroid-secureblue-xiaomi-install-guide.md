# PTTdroid Installation and Configuration

## Fedora Secureblue + rootless Podman + Xiaomi Android TV

**Purpose:** Deploy the self-hosted PTTdroid relay on the Fedora
Secureblue host, install the Android client on the Xiaomi TV, configure
encrypted connectivity, and verify microphone/audio operation.

**Upstream projects** - Android client:
<https://github.com/devapro/ptt-client-android> - Relay server:
<https://github.com/devapro/ptt-server>

**Deployment model** - Fedora Secureblue runs the relay using rootless
Podman and a systemd user Quadlet. - Xiaomi Android TV runs the PTTdroid
Android client. - A second PTTdroid client is recommended for end-to-end
audio testing. - The relay uses `wss://` with a persistent self-signed
certificate, SHA-256 certificate pinning, and a shared access token.

> **Scope limitation:** PTTdroid is a walkie-talkie relay. The server
> forwards live PCM audio between connected PTTdroid clients; it does
> not transcribe audio, call Ollama, execute Home Security commands, or
> generate TTS. Integrating the audio stream with the Home Security AI
> stack requires a separate PTT protocol bridge.
>
> **Hardware limitation:** Upstream does not document Xiaomi Android TV
> certification or support for the Xiaomi Bluetooth remote's microphone
> button. The Android app uses `AudioRecord`, but that does not prove
> the remote microphone is exposed to third-party apps. Treat
> remote-microphone and D-pad hold behavior as tests, not guaranteed
> features.

------------------------------------------------------------------------

## 1. Deployment overview

``` text
Xiaomi Android TV
  └── PTTdroid Android app
        ├── RECORD_AUDIO permission
        ├── AudioRecord capture
        ├── Hold-to-talk control
        └── WSS connection + access token
                  |
                  | TLS / WebSocket :8443
                  v
Fedora Secureblue
  └── Rootless Podman: ptt-server
        ├── TLS-only listener
        ├── Shared token authentication
        ├── Channel membership / talk-floor control
        └── Live PCM16LE audio relay
                  |
                  v
Second PTTdroid client (recommended for testing)
```

PTTdroid protocol v1 uses fixed audio parameters:

  Property          Value
  ----------------- -----------------------------------------
  Sample rate       16,000 Hz
  Channels          Mono
  Encoding          Signed 16-bit little-endian PCM
  Frame size        1,280 bytes / 40 ms
  Maximum frame     8,192 bytes
  Audio bandwidth   Approximately 32 kB/s per active talker

The relay does not store audio. Channels and sessions exist only while
clients are connected.

## 2. Prerequisites

### Fedora Secureblue host

-   Rootless Podman working under the normal user account.
-   Git, curl, OpenSSL, Python 3, `ip`, `firewall-cmd`, and `systemctl`.
-   A network address reachable by the Xiaomi TV.
-   TCP port `8443` available.
-   Sufficient disk space to clone and build the relay image.

Check the environment:

``` bash
podman --version
podman info --format 'Rootless={{.Host.Security.Rootless}}'
git --version
curl --version
openssl version
firewall-cmd --state
systemctl --user is-system-running || true
```

Confirm Podman is rootless:

``` bash
test "$(podman info --format '{{.Host.Security.Rootless}}')" = "true" \
  && echo "Rootless Podman confirmed" \
  || { echo "STOP: Podman is not running rootless"; exit 1; }
```

Do not use `sudo podman` for this deployment. Rootful Podman has a
separate image and volume store.

### Xiaomi Android TV

-   Enable Developer Options.
-   Enable Wireless debugging / Network debugging.
-   Have the TV IP address and pairing information available.
-   Keep the TV and Fedora host on a network that permits
    device-to-device traffic.

### Network values used in this guide

Set the values for the actual network before applying firewall rules:

``` bash
# Example only: verify the actual home LAN subnet and host address first.
export LAN_CIDR="192.168.1.0/24"
export TV_IP="<XIAOMI_TV_IP>"
```

Find the Fedora host address:

``` bash
ip -4 route
ip -4 addr
hostname -I
```

Do not use `127.0.0.1` as the server address in the TV app. That address
would refer to the TV itself.

------------------------------------------------------------------------

## 3. Install host-side tools on Secureblue

If the required tools are missing, layer them using rpm-ostree:

``` bash
sudo rpm-ostree install android-tools git curl openssl jq
```

Reboot if rpm-ostree reports that a deployment is pending:

``` bash
systemctl reboot
```

After reboot:

``` bash
adb version
git --version
podman --version
```

If a tool is already available, do not layer another copy unnecessarily.

## 4. Download the PTT server source

Use a dedicated directory:

``` bash
mkdir -p "$HOME/src"
cd "$HOME/src"

if [ ! -d ptt-server/.git ]; then
  git clone https://github.com/devapro/ptt-server.git
fi

cd "$HOME/src/ptt-server"
git status --short
git log -1 --oneline
```

Review the upstream deployment files before building:

``` bash
sed -n '1,240p' docs/running-your-own.md
sed -n '1,240p' docs/configuration.md
sed -n '1,240p' docs/deployment.md
sed -n '1,200p' Dockerfile
```

The server's Dockerfile builds with JDK 21 and runs the resulting
application as a non-root container user.

## 5. Create server secrets and configuration

The server supports a shared `PTT_AUTH_TOKEN`. It also supports TLS with
a generated PKCS#12 certificate. The certificate and its SHA-256
fingerprint must persist across restarts.

Create a private configuration directory:

``` bash
install -d -m 700 "$HOME/.config/pttdroid"
```

Generate secrets and write the environment file:

``` bash
umask 077

PTT_TOKEN="$(openssl rand -hex 32)"
PTT_TLS_PASSWORD="$(openssl rand -hex 32)"

cat > "$HOME/.config/pttdroid/server.env" <<EOF
PTT_HOST=0.0.0.0
PTT_PORT=8000
PTT_HTTP_ENABLED=false

PTT_TLS_ENABLED=true
PTT_TLS_PORT=8443
PTT_TLS_KEYSTORE=/app/certs/ptt.p12
PTT_TLS_KEYSTORE_PASSWORD=${PTT_TLS_PASSWORD}
PTT_TLS_KEY_PASSWORD=${PTT_TLS_PASSWORD}
PTT_TLS_KEY_ALIAS=ptt
PTT_TLS_SAN=localhost,127.0.0.1
PTT_TLS_VALIDITY_DAYS=3650

PTT_AUTH_TOKEN=${PTT_TOKEN}

PTT_MAX_AUDIO_FRAME_BYTES=8192
PTT_PING_SECONDS=15
PTT_MAX_CHANNEL=99
PTT_OUTBOUND_QUEUE=64
PTT_MAX_SESSIONS_PER_CHANNEL=4
EOF

chmod 600 "$HOME/.config/pttdroid/server.env"
unset PTT_TOKEN PTT_TLS_PASSWORD
```

Verify file permissions without printing the secrets:

``` bash
stat -c '%a %n' "$HOME/.config/pttdroid/server.env"
grep -E '^(PTT_HTTP_ENABLED|PTT_TLS_ENABLED|PTT_TLS_PORT|PTT_MAX_CHANNEL|PTT_MAX_SESSIONS_PER_CHANNEL)=' \
  "$HOME/.config/pttdroid/server.env"
```

Expected permissions: `600`.

**Important security properties**

-   `PTT_HTTP_ENABLED=false` disables the plaintext WebSocket listener.
-   `PTT_TLS_ENABLED=true` enables the encrypted WebSocket listener.
-   `PTT_AUTH_TOKEN` is required by clients.
-   The certificate is stored in `/app/certs` and must not be deleted
    casually.
-   PTTdroid currently uses one shared token for all clients. It has no
    per-device credentials or individual revocation.

Do not commit `server.env` to Git or paste its contents into logs or
support requests.

## 6. Build the relay image with rootless Podman

Build from the server repository:

``` bash
cd "$HOME/src/ptt-server"

podman build \
  --tag localhost/ptt-server:local \
  .
```

Confirm the image exists:

``` bash
podman image inspect localhost/ptt-server:local \
  --format 'Image={{.Id}} Created={{.Created}}'
```

Create the persistent certificate volume:

``` bash
podman volume exists ptt-certs \
  || podman volume create ptt-certs

podman volume inspect ptt-certs
```

Do not run `podman volume rm ptt-certs` or `podman volume prune` as
routine cleanup. Removing the volume regenerates the certificate and
invalidates the fingerprint configured on the TV.

## 7. Deploy the relay with a systemd user Quadlet

Quadlet is preferred over a hand-written `podman start --attach`
service.

Create the user Quadlet directory:

``` bash
mkdir -p "$HOME/.config/containers/systemd"
```

Create the container definition:

``` bash
cat > "$HOME/.config/containers/systemd/ptt-server.container" <<EOF
[Unit]
Description=PTTdroid self-hosted relay
Wants=network-online.target
After=network-online.target

[Container]
Image=localhost/ptt-server:local
ContainerName=ptt-server
EnvironmentFile=$HOME/.config/pttdroid/server.env
PublishPort=8443:8443
Volume=ptt-certs:/app/certs

[Service]
Restart=always
TimeoutStartSec=900

[Install]
WantedBy=default.target
EOF
```

Load and start the generated service:

``` bash
systemctl --user daemon-reload
systemctl --user enable --now ptt-server.service
```

Enable lingering so the user service can start at boot without an
interactive login:

``` bash
sudo loginctl enable-linger "$USER"
```

Check the service and container:

``` bash
systemctl --user status ptt-server.service --no-pager
podman ps --filter name=ptt-server
podman logs --tail 100 ptt-server
```

The Quadlet service is expected to be named `ptt-server.service`.

If the unit is not generated, inspect the Quadlet generator and logs:

``` bash
systemctl --user daemon-reload
systemctl --user list-unit-files | grep ptt
journalctl --user -b --no-pager | grep -iE 'quadlet|ptt-server'
```

## 8. Configure Fedora firewall access

The relay should be reachable only from the trusted LAN. Do not expose
TCP 8443 to the public internet.

First identify the interface and firewalld zone used by the LAN route:

``` bash
ip -4 route show default
firewall-cmd --get-active-zones
firewall-cmd --get-default-zone
```

Set `LAN_CIDR` to the real trusted subnet. The following uses
`192.168.1.0/24` as an example; change it if the network differs.

``` bash
LAN_CIDR="192.168.1.0/24"
ZONE="$(firewall-cmd --get-default-zone)"

sudo firewall-cmd --permanent --zone="$ZONE" \
  --add-rich-rule="rule family=\"ipv4\" source address=\"$LAN_CIDR\" port port=\"8443\" protocol=\"tcp\" accept"

sudo firewall-cmd --reload
sudo firewall-cmd --zone="$ZONE" --list-rich-rules
```

If the host's LAN interface is assigned to a different zone, use that
zone instead of the default zone.

Do not add a broad `--add-port=8443/tcp` rule unless the host firewall
policy intentionally permits all sources in that zone.

## 9. Validate the relay before configuring Android

Check the container:

``` bash
podman ps --filter name=ptt-server
podman logs --tail 100 ptt-server
```

Check the TLS health endpoint locally:

``` bash
curl --insecure --fail --show-error \
  https://127.0.0.1:8443/health
```

Expected response shape:

``` json
{"status":"ok","channels":0,"sessions":0,"protocolVersion":1}
```

`--insecure` is used only for this local health check because the relay
generates a self-signed certificate. It is not the client security
configuration.

Retrieve the certificate fingerprint:

``` bash
podman exec ptt-server \
  cat /app/certs/ptt.p12.sha256
```

Record the SHA-256 fingerprint securely. It is not a secret, but it must
be transferred to the TV through a trusted channel.

Verify the fingerprint file exists:

``` bash
podman exec ptt-server \
  test -s /app/certs/ptt.p12.sha256 \
  && echo "TLS fingerprint is present"
```

Check the listening port:

``` bash
ss -lnt | grep ':8443'
```

From another device on the same LAN, test:

``` bash
curl --insecure --fail --show-error \
  https://<FEDORA_HOST_LAN_IP>:8443/health
```

If the local check works but the remote check fails, investigate the
firewalld zone, LAN subnet, guest Wi-Fi isolation, and routing before
proceeding.

## 10. Install ADB and connect to the Xiaomi TV

Enable developer options on the TV:

1.  Open **Settings → Device Preferences → About** (menu names vary by
    firmware).
2.  Select **Build** seven times.
3.  Return to Settings and open **Developer options**.
4.  Enable **Wireless debugging** or **Network debugging**.
5.  If prompted, approve the debugging connection.

Find the TV IP address in the TV's network settings or router DHCP
client list.

### Android 11+ wireless debugging

When the TV shows a pairing address and pairing port:

``` bash
adb pair "<TV_IP>:<PAIRING_PORT>"
```

Enter the pairing code shown on the TV.

Then connect using the separate connection address and port shown by
Wireless debugging:

``` bash
adb connect "<TV_IP>:<CONNECT_PORT>"
adb devices -l
```

### Older network debugging mode

Some Android TV firmware exposes ADB directly on port 5555:

``` bash
adb connect <TV_IP>:5555
adb devices -l
```

Use the method exposed by the TV firmware. Do not assume the pairing
port and connection port are the same.

Inspect the device:

``` bash
adb shell getprop ro.product.model
adb shell getprop ro.product.device
adb shell getprop ro.build.version.release
adb shell getprop ro.build.version.sdk
adb shell getprop ro.product.cpu.abilist
```

Save the output with the deployment notes. This is required to
investigate device-specific microphone behavior.

## 11. Download and install the signed PTTdroid APK

The upstream README states that tagged releases include a signed Android
APK.

Download the APK asset from the latest published GitHub release:

``` bash
mkdir -p "$HOME/Downloads/pttdroid"
cd "$HOME/Downloads/pttdroid"

RELEASE_JSON="$(curl -fsSL \
  -H 'Accept: application/vnd.github+json' \
  https://api.github.com/repos/devapro/ptt-client-android/releases/latest)"

APK_URL="$(printf '%s' "$RELEASE_JSON" | python3 -c '
import json
import sys

release = json.load(sys.stdin)
assets = release.get("assets", [])
apks = [
    asset for asset in assets
    if asset.get("name", "").lower().endswith(".apk")
]
if not apks:
    raise SystemExit("No APK asset found in the latest published release")
apks.sort(
    key=lambda asset: (
        "pttdroid" not in asset.get("name", "").lower(),
        asset.get("name", "")
    )
)
print(apks[0]["browser_download_url"])
')"

test -n "$APK_URL" || {
  echo "Could not resolve the APK download URL" >&2
  exit 1
}

curl --fail --location --retry 3 \
  "$APK_URL" \
  --output PTTdroid.apk

file PTTdroid.apk
sha256sum PTTdroid.apk
```

If the GitHub API reports that there is no published latest release or
no APK asset, use the source-build procedure in section 12.

Install the APK:

``` bash
adb devices -l
adb install -r "$HOME/Downloads/pttdroid/PTTdroid.apk"
```

Do not use `adb install -g` by default. Grant the microphone permission
through Android's permission prompt or app settings so the permission is
reviewed explicitly.

Confirm the package is installed:

``` bash
adb shell dumpsys package com.github.devapro.pttdroid \
  | grep -E 'versionName|versionCode'
```

Launch the application:

``` bash
adb shell monkey -p com.github.devapro.pttdroid 1
```

The current manifest declares a standard Android launcher activity. It
does not establish Android TV launcher certification. If the app does
not appear in the TV launcher, use the ADB launch command above.

## 12. Optional: build the Android APK from source

Use this path if you want to inspect/build the client yourself or if the
release APK is unavailable.

The upstream build documentation specifies:

-   JDK 21.
-   Android SDK platform `android-36`.
-   Android Build Tools `36.0.0` or newer.
-   Gradle wrapper supplied by the repository (documented as Gradle
    9.7.1).

Install JDK 21 and Git if required:

``` bash
sudo rpm-ostree install java-21-openjdk-devel git
```

Set the Android SDK location. Adjust it if Android Studio installed the
SDK elsewhere:

``` bash
export ANDROID_HOME="$HOME/Android/Sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
```

Verify the toolchain:

``` bash
java -version
adb version
sdkmanager --version
```

Accept SDK licenses and install the required components:

``` bash
yes | sdkmanager --licenses
sdkmanager \
  "platform-tools" \
  "platforms;android-36" \
  "build-tools;36.0.0"
```

Clone and build:

``` bash
cd "$HOME/src"

if [ ! -d ptt-client-android/.git ]; then
  git clone https://github.com/devapro/ptt-client-android.git
fi

cd "$HOME/src/ptt-client-android"

./gradlew --version
./gradlew assembleDebug
```

Check the APK output:

``` bash
find app/build/outputs/apk/debug -maxdepth 1 -type f -name 'PTTdroid-*-debug.apk' -print
```

Install the generated debug APK:

``` bash
APK="$(find app/build/outputs/apk/debug -maxdepth 1 \
  -type f -name 'PTTdroid-*-debug.apk' -print -quit)"

test -n "$APK" || {
  echo "Debug APK was not produced" >&2
  exit 1
}

adb install -r "$APK"
```

The upstream build guide notes that a locally built release APK is
unsigned unless release signing variables are configured. Use the
upstream signed release APK for normal installation unless you have a
controlled signing-key process.

## 13. Configure PTTdroid on the Xiaomi TV

Open PTTdroid.

### 13.1 Grant microphone permission

When prompted, allow microphone access.

If permission was previously denied:

1.  Open Android TV **Settings → Apps → PTTdroid → Permissions**.
2.  Allow microphone access.
3.  Return to PTTdroid.

The application uses Android `AudioRecord`. The microphone permission is
mandatory for transmission.

### 13.2 Configure the relay

Open **Settings → Relay**.

1.  Select **Custom**.

2.  Enter the Fedora host address and TLS port as a full URL:

    ``` text
    wss://<FEDORA_HOST_LAN_IP>:8443
    ```

3.  Confirm the preview shows a `wss://` connection to the correct host
    and port.

4.  Save and reconnect.

The address field also accepts a host or `host:port`, but using the
complete `wss://` URL makes the intended transport explicit.

### 13.3 Configure security

Open **Settings → Security**.

Set:

  Setting                   Value
  ------------------------- ---------------------------------------------
  Encrypted connection      Enabled
  Certificate fingerprint   SHA-256 fingerprint from section 9
  Access token              Value of `PTT_AUTH_TOKEN` from `server.env`

Retrieve the token without printing it into documentation or a terminal
transcript:

``` bash
read -r -s -p "PTT access token: " PTT_TOKEN
echo
```

Paste the value into the app's Access token field. Clear the temporary
shell variable afterward:

``` bash
unset PTT_TOKEN
```

The client pins the SHA-256 fingerprint of the self-signed certificate.
Colons and letter case in the fingerprint are not significant according
to the upstream README.

Do not enable encryption with the app's built-in on-device relay. The
on-device relay is plaintext-only; this deployment uses the separate
TLS-enabled `ptt-server`.

### 13.4 Configure identity and channel

Under **Settings → Identity**:

-   Set a display name, for example `Xiaomi-TV`.
-   Keep the name at or below 32 characters.

Set the channel to `1`.

All clients that should hear each other must use the same relay and
channel.

### 13.5 Connect

Return to the main screen and use **Connect** if the session is not
already connected.

Expected states:

  State       Meaning
  ----------- -----------------------------------------------
  `OFFLINE`   Not connected; inspect the error banner
  `LINKING`   Connecting or reconnecting
  `HOLD`      Connected and channel floor is free
  `WAIT`      Waiting for the relay to grant the talk floor
  `ON AIR`    This client owns the talk floor
  `BUSY`      Another client owns the talk floor

The app should show the connected state before attempting to transmit.

## 14. Test the audio path

A relay with one connected Xiaomi client cannot prove that audio reaches
another endpoint. Use a second PTTdroid client on an Android phone,
tablet, or desktop.

Configure the second client with:

-   The same `wss://<FEDORA_HOST_LAN_IP>:8443` relay.
-   The same certificate fingerprint.
-   The same access token.
-   The same channel number (`1`).
-   A different display name.

### Test 1: relay health

On Fedora:

``` bash
curl --insecure --fail --show-error \
  https://127.0.0.1:8443/health
```

### Test 2: session count

On Fedora:

``` bash
curl --insecure --fail --show-error \
  https://127.0.0.1:8443/health
```

With two clients connected to channel 1, the response should report one
channel and two sessions, for example:

``` json
{"status":"ok","channels":1,"sessions":2,"protocolVersion":1}
```

### Test 3: talk-floor control

1.  Put both clients on channel 1.
2.  Confirm both show `HOLD`.
3.  Hold PTT on the Xiaomi client.
4.  Confirm the second client changes to `BUSY` and identifies the
    talker.
5.  Release PTT.
6.  Confirm the channel becomes available again.

The server grants the floor before the microphone starts. A press should
not open the microphone until the server grants the floor.

### Test 4: microphone capture

On the Xiaomi TV:

1.  Hold the PTT control.
2.  Speak normally.
3.  Confirm the second client receives intelligible audio.
4.  Release the PTT control.
5.  Confirm transmission stops.

Repeat in the opposite direction from the second client to the TV.

The relay's health endpoint reports session counts, not audio quality.
Successful floor control alone does not prove microphone capture or
playback works.

## 15. Xiaomi remote microphone and Android TV interaction tests

These are device-specific tests. Upstream documentation does not claim
that the Xiaomi remote microphone button is exposed to third-party apps.

### 15.1 Test the on-screen PTT control first

Try the TV remote's D-pad:

1.  Navigate focus to the PTT control.
2.  Try holding the remote's OK/Select key.
3.  Check whether the app remains in `ON AIR` only while the key is
    held.
4.  Release the key and confirm the transmission stops.

The app's documented primary interaction is a press-and-hold pointer
gesture. D-pad long-press behavior is not guaranteed by the upstream
documentation.

If the D-pad cannot produce a continuous hold, use a USB mouse,
touchpad, or compatible input device for the initial proof of concept.
Do not treat a single click as equivalent to hold-to-talk.

### 15.2 Test the original Xiaomi remote microphone

PTTdroid documents support for: - Volume keys while the app is on screen
(opt-in). - A headset media button while the background session runs. -
The app's own on-screen PTT control. - A floating PTT overlay on
supported Android devices.

It does **not** document direct handling of the Xiaomi Assistant
microphone key.

Inspect audio policy information:

``` bash
adb shell dumpsys audio
adb shell dumpsys media.audio_policy
```

Test the microphone with the PTTdroid app and a second client. If the
remote's microphone does not deliver audio, do not assume the PTT server
is faulty.

Possible outcomes:

  -----------------------------------------------------------------------
  Observation                         Interpretation
  ----------------------------------- -----------------------------------
  TV transmits intelligible speech    The selected microphone input works

  TV gets `ON AIR`, but the receiver  Investigate microphone routing,
  hears silence                       permission, and capture

  Remote mic works only with Google   Firmware may reserve the mic path
  Assistant                           for Assistant

  D-pad OK only clicks once           Remote does not provide a usable
                                      press-and-hold gesture to this UI

  USB microphone works but remote mic Use USB microphone or build a
  does not                            device-specific input integration
  -----------------------------------------------------------------------

Do not disable Google system packages or modify firmware as a first
troubleshooting step.

## 16. Useful server operations

### Status

``` bash
systemctl --user status ptt-server.service --no-pager
podman ps --filter name=ptt-server
```

### Logs

``` bash
podman logs --tail 100 ptt-server
podman logs --follow ptt-server
```

### Restart

``` bash
systemctl --user restart ptt-server.service
```

The persistent `ptt-certs` volume preserves the TLS certificate across
restarts.

### Stop

``` bash
systemctl --user stop ptt-server.service
```

### Start

``` bash
systemctl --user start ptt-server.service
```

### Check health

``` bash
curl --insecure --fail --show-error \
  https://127.0.0.1:8443/health
```

### Inspect the certificate fingerprint

``` bash
podman exec ptt-server \
  cat /app/certs/ptt.p12.sha256
```

### Update the server

Review upstream changes before updating:

``` bash
cd "$HOME/src/ptt-server"
git fetch --all --tags
git status --short
git pull --ff-only
```

Rebuild and restart:

``` bash
podman build --tag localhost/ptt-server:local .
systemctl --user restart ptt-server.service
```

Verify:

``` bash
systemctl --user status ptt-server.service --no-pager
podman logs --tail 100 ptt-server
curl --insecure --fail --show-error \
  https://127.0.0.1:8443/health
```

The named certificate volume remains in place during this update. If
upstream changes the protocol version, update the Android client and
server together.

## 17. Troubleshooting

  -----------------------------------------------------------------------------------------
  Symptom                             Checks
  ----------------------------------- -----------------------------------------------------
  `ptt-server.service` not found      Confirm Quadlet file path, run
                                      `systemctl --user daemon-reload`, inspect user
                                      journal

  Container exits                     `podman logs ptt-server`; check environment file and
                                      TLS settings

  TLS listener not available          Confirm `PTT_TLS_ENABLED=true`,
                                      `PTT_HTTP_ENABLED=false`, and port 8443

  Local health check fails            Check service status, container logs, and TLS startup
                                      errors

  Remote health check hangs           Check firewalld zone/rich rule, host IP, subnet,
                                      guest Wi-Fi isolation

  Client immediately shows `OFFLINE`  Check server address, TLS toggle, fingerprint, token,
                                      and server logs

  Fingerprint mismatch                Compare the app value with
                                      `/app/certs/ptt.p12.sha256`; do not delete the
                                      certificate volume

  `unauthorized`                      Client access token does not match `PTT_AUTH_TOKEN`

  `unsupported_version`               Client and server protocol versions differ; update
                                      both

  `invalid_channel`                   Channel must be in the configured range, normally
                                      1--99

  `channel_full`                      `PTT_MAX_SESSIONS_PER_CHANNEL` limit reached

  Both clients show `HOLD`, no audio  Check microphone permission, audio input, speaker
                                      volume, and actual microphone capture

  Emulator captures silence           Upstream documents that emulator microphones may
                                      capture silence; test on physical devices

  TV app not visible in launcher      Start it with
                                      `adb shell monkey -p com.github.devapro.pttdroid 1`

  TV remote cannot hold PTT           Test a USB mouse/touchpad; D-pad hold behavior is not
                                      guaranteed

  Remote mic unavailable              Test another microphone input; Xiaomi Assistant mic
                                      integration is unverified
  -----------------------------------------------------------------------------------------

## 18. Security and operational notes

-   Keep the relay on the trusted LAN or an authenticated private
    network.
-   Do not port-forward TCP 8443 from the internet.
-   Keep the plaintext connector disabled.
-   Keep the environment file mode `600`.
-   Do not mount the Podman socket into the relay.
-   Do not run the relay container privileged.
-   Do not use rootful Podman for this deployment.
-   Do not delete the `ptt-certs` volume during cleanup.
-   The access token is shared by all clients. Rotate it by updating the
    server environment file and every client configuration.
-   The server does not provide per-client identities, per-client
    revocation, or a persistent audit trail.
-   Audio is forwarded live and is not stored by the relay.

## 19. Removal / rollback

Stop and disable the user service:

``` bash
systemctl --user disable --now ptt-server.service
```

Remove the Quadlet definition:

``` bash
rm -f "$HOME/.config/containers/systemd/ptt-server.container"
systemctl --user daemon-reload
```

Remove the container and image:

``` bash
podman rm -f ptt-server 2>/dev/null || true
podman image rm localhost/ptt-server:local
```

Remove the certificate volume **only if you intentionally want to
destroy the TLS identity**:

``` bash
podman volume rm ptt-certs
```

Remove the secret file only when the deployment is permanently retired:

``` bash
shred -u "$HOME/.config/pttdroid/server.env"
```

`shred` is not guaranteed to securely erase data on copy-on-write
filesystems or SSDs. Prefer cryptographic protection of the underlying
storage and treat old backups as containing the secret.

Remove the firewall rule using the same zone and CIDR used during
installation:

``` bash
LAN_CIDR="192.168.1.0/24"
ZONE="$(firewall-cmd --get-default-zone)"

sudo firewall-cmd --permanent --zone="$ZONE" \
  --remove-rich-rule="rule family=\"ipv4\" source address=\"$LAN_CIDR\" port port=\"8443\" protocol=\"tcp\" accept"

sudo firewall-cmd --reload
```

Uninstall PTTdroid from the TV if required:

``` bash
adb uninstall com.github.devapro.pttdroid
```

------------------------------------------------------------------------

## 20. Acceptance checklist

### Fedora relay

-   [ ] Rootless Podman confirmed.
-   [ ] Server image built successfully.
-   [ ] `ptt-server.service` enabled and active.
-   [ ] TLS listener is available on TCP 8443.
-   [ ] Plaintext listener is disabled.
-   [ ] Certificate fingerprint file exists and is recorded.
-   [ ] Authentication token is configured.
-   [ ] Firewall allows TCP 8443 only from the trusted LAN.
-   [ ] Health endpoint returns `status: ok`.

### Xiaomi client

-   [ ] ADB connection established.
-   [ ] Device model and Android version recorded.
-   [ ] PTTdroid installed.
-   [ ] Microphone permission granted.
-   [ ] Custom relay URL configured with `wss://`.
-   [ ] TLS enabled and fingerprint matches.
-   [ ] Access token configured.
-   [ ] Identity and channel configured.
-   [ ] Client connects and displays `HOLD`.

### End-to-end audio

-   [ ] Second client connected to the same relay and channel.
-   [ ] Talk-floor state changes correctly.
-   [ ] Xiaomi microphone audio is received by the second client.
-   [ ] Second-client audio is received by Xiaomi.
-   [ ] PTT release stops transmission.
-   [ ] Reconnect works after restarting the relay.
-   [ ] Original Xiaomi remote microphone tested separately.
-   [ ] D-pad press-and-hold tested separately.

## 21. Home Security AI integration: next phase

The completed deployment above is only the PTT transport layer.

To connect PTTdroid to the Home Security AI workflow, implement a
separate bridge that speaks the upstream PTT protocol v1:

-   WebSocket endpoint: `/channel/{channelId}?name={displayName}&v=1`
-   Authentication header: `X-PTT-Token`
-   Control messages: `talk_request`, `talk_release`, `ping`, and server
    `floor`/`welcome` messages.
-   Audio: binary PCM16LE frames, 16 kHz mono, 1,280 bytes per 40 ms
    frame.
-   The bridge must wait for a server `floor` grant before transmitting.
-   The bridge must release the floor on completion and handle
    disconnects.
-   The bridge can feed received PCM audio to faster-whisper, pass the
    transcript to Ollama for strict allowlisted intent extraction, and
    return generated speech through a controlled response path.

Do not treat PTTdroid's relay as an HTTP transcription API. It does not
provide that integration itself.

------------------------------------------------------------------------

## 22. Upstream references

-   Client README: <https://github.com/devapro/ptt-client-android>
-   Client platform support:
    <https://github.com/devapro/ptt-client-android/blob/main/docs/platform-support.md>
-   Client build and run:
    <https://github.com/devapro/ptt-client-android/blob/main/docs/build-and-run.md>
-   Client audio pipeline:
    <https://github.com/devapro/ptt-client-android/blob/main/docs/audio-pipeline.md>
-   Client features:
    <https://github.com/devapro/ptt-client-android/blob/main/docs/features.md>
-   Client Android manifest:
    <https://github.com/devapro/ptt-client-android/blob/main/app/src/main/AndroidManifest.xml>
-   Server README: <https://github.com/devapro/ptt-server>
-   Server running guide:
    <https://github.com/devapro/ptt-server/blob/main/docs/running-your-own.md>
-   Server configuration:
    <https://github.com/devapro/ptt-server/blob/main/docs/configuration.md>
-   Server deployment:
    <https://github.com/devapro/ptt-server/blob/main/docs/deployment.md>
-   Server protocol v1:
    <https://github.com/devapro/ptt-server/blob/main/docs/protocol.md>
-   Podman rootless documentation:
    <https://github.com/containers/podman/blob/main/docs/tutorials/rootless_tutorial.md>

**Licensing:** Both PTTdroid client and server identify as GPL-3.0-only.
Review the license obligations before distributing modified or combined
builds.
