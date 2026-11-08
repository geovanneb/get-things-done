# Device inbox

Lets a phone send meetings to this computer over the local network, on a hotspot or a shared Wi-Fi. Meetlaud for iPhone is the first client. It is off by default.

## What it is not

It is not the dashboard's server. That one stays on `127.0.0.1`, and nothing on the network can reach the API or the workspace. The inbox is a small separate server that accepts sealed files from paired phones and nothing else, and it listens only while turned on.

## How a phone connects

1. **Finding it.** On macOS the computer announces `_gtd-inbox._tcp` with `dns-sd`, with `v=1` and `fp`, the fingerprint of its public key. The pairing code also holds the port and addresses, for networks where a name cannot be found.
2. **Pairing.** Settings shows a QR code with the computer's public key and a one-time secret. It works once, for five minutes, and five wrong tries spend it. The phone proves it read the code with `HMAC-SHA256(secret, phone public key)`, and the computer proves the same with its own key, so that neither trusts a stranger on the network.
3. **Sealing.** Both sides derive one key: X25519, then HKDF-SHA256 with the salt `meetlaud-sync-v1` and the info `device-inbox-key`. Everything after pairing is AES-256-GCM, as nonce + ciphertext + tag, and the additional data is the place it is sent to, so that a seal cannot be replayed somewhere else.

The phone always starts. The computer never asks for anything.

## Requests

Each one carries `X-Device`, the phone's id. Bodies and answers are sealed, and answers use `answer:<path>` as their additional data.

| Method | Path | Sealed body | Answer |
|---|---|---|---|
| `POST` | `/v1/pair` | Not sealed: `phone_public`, `phone_name`, `proof` | `proof` |
| `POST` | `/v1/offer` | `items`: `id` (a UUID), `title`, `date`, `files` (`name`, `size`, `sha256`) | `items`: `id`, `complete`, `files` (bytes held) |
| `PUT` | `/v1/items/:id/files/:index?offset=N` | Up to 2 MB of the file. The additional data includes the offset | `received` |
| `POST` | `/v1/items/:id/commit` | `{}` | `meeting_id` |

An upload resumes from what the offer reports. A chunk at any other offset changes nothing and answers with what is held. Commit checks every SHA-256, then adds the files through the same path as an upload in the dashboard, and queues the meeting. Sending a delivered meeting again changes nothing. Concurrent offers, chunks and commits for the same item are serialized within a listener, so overlapping retries do not append or deliver twice. A checksum failure discards the damaged file; offer again to obtain its new offset. Filenames must be unique without regard to case, and inbox paths cannot pass through symlinks. Failed file validation removes the draft created by that delivery attempt while retaining the inbox files.

Pairing codes are consumed before saving a device. Cancelling a code or forgetting a phone also refuses requests still receiving their bodies. This does not roll back an operation already executing. The in-memory serialization is per listener, not a transaction across processes or a durable delivery journal: a process crash between queueing a meeting and saving its receipt can still require manual duplicate cleanup.

## Where things live

Keys and paired phones are in `~/.gtd/device-inbox/state.json`, readable only by the owner, and never in the workspace, which may be synced. Files wait under `~/.gtd/device-inbox/` until they are delivered.

## Changing this

The tests in `server/tests/device-inbox.test.ts` hold fixed values shared with Meetlaud. If they change, every paired phone stops working.
