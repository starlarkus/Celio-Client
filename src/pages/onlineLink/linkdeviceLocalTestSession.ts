import { Subscription } from 'rxjs';
import { DataArray, LinkDeviceService, LinkStatus } from '../../services/linkdevice.service';

// Local-test fake slave. No WebSocket, no partner — runs entirely in the
// browser. Receives 64-byte USB packets from the adapter (what the master
// GBA's firmware forwards) and synthesises slave responses to unstick the
// master GBA's lobby → map-select transition.
//
// Key observation from AW1 decomp (libraries.s:103767 sub_8032EB0):
// After pressing start, master emits its own 0x3B size-0x42 block packet
// and then loops waiting for `ctx[9] == gUnknown_030041D4`. Master's
// ctx[9] has bits 0 AND 1 set (both slots registered). gUnknown_030041D4
// bit 0 gets set by master's own block loopback via SIOMULTI0 echo, but
// bit 1 requires receiving a 0x3B block FROM slot 1. So the fake slave
// must emit its own 0x3B block with data[0]=0x013B (slot 1, cmd 0x3B).
//
// Block packet wire format (69 halfwords):
//   [0] 0x4FFF header
//   [1] 0x0042 size (= 66 data halfwords)
//   [2] checksum = (0x4FFF + 0x0042) + Σ (i+1)*data[i]
//   [3..68] data[0..65]
//
// For a minimum-viable fake slave 0x3B block with data[0]=0x013B and
// data[1..65]=0, checksum = 0x5041 + 0x013B = 0x517C.

const SLAVE_BLOCK_HEADER = 0x4FFF;
const SLAVE_BLOCK_SIZE = 0x0042;
const SLAVE_BLOCK_CKSUM = 0x517C;     // (0x4FFF + 0x0042) + 1*0x013B
const SLAVE_BLOCK_DATA0 = 0x013B;     // slot 1, cmd 0x3B

// Small 5-halfword packets from slot 1 that master's jump-table handlers
// expect to see to set their respective bits:
//   0x3A → sets gUnknown_030048B4 bit 1
//   0x3E → sets ctx[0x1c] bit 1 (with data[1]=rotation+1=1)
// Format: [0x4FFF, 0x0002, cksum, data[0]=(1<<8)|cmd, data[1]]
// Checksum: (0x4FFF + 0x0002) + 1*data[0] + 2*data[1]
const SLAVE_0X3A_PACKET = [0x4FFF, 0x0002, 0x513B, 0x013A, 0x0000]; // cksum 0x5001+0x013A = 0x513B

// Slot-1 0x3E rotation-ack. Master emits 0x3E with a rotation counter in
// data[1] that alternates between turn actions (1, 0, 1, 0, ...). Slot 1
// must mirror data[1] or master's PACKETXG handshake stalls.
// cksum = (0x4FFF + 0x0002) + 1*0x013E + 2*data[1] = 0x513F + 2*data[1]
function buildSlave3ePacket(rot: number): number[] {
  const d1 = rot & 0xFFFF;
  const cksum = (0x513F + 2 * d1) & 0xFFFF;
  return [0x4FFF, 0x0002, cksum, 0x013E, d1];
}

// Size-13 slot-1 "turn ack" reply. Simple minimal-data variant: slot indicator
// + mirrored seq + all zeros. Works for simple actions (move, capture). Some
// complex actions (load into transport) seem to require more — under
// investigation.
function buildSlave3fTurnPacket(seq: number): number[] {
  const cksum = (0x514B + 2 * seq) & 0xFFFF;
  return [
    0x4FFF, 0x000D, cksum, 0x013F,
    seq & 0xFFFF,
    0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
    0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
  ];
}

const CMD_SYNC_AW1 = 0x5678;
const CMD_SYNC_AW2 = 0x9ABC;
const CMD_NONE     = 0x7FFF;
const CMD_NOP      = 0x5FFF;

// INTERSYNC key-input range. Per gpsp serial_proto.c:508-523, when master is in
// STATE_INTERSYNC and emits a halfword in [0x8000, 0x9F00], slot 1 must echo
// `(mvalue & 0xFC00)` (category bits). For CMD_NOP the slave echoes the
// category of the last key-input. Without these replies the master's battle
// handler times out and drops the link.
const INTERSYNC_MIN = 0x8000;
const INTERSYNC_MAX = 0x9F00;

// GBA KEYINPUT bits used as INTERSYNC key-state encoding (low 10 bits of
// halfword). Browser key bindings so the tester can drive slot 1 manually.
const GBA_KEY = {
  A:      0x001,
  B:      0x002,
  SELECT: 0x004,
  START:  0x008,
  RIGHT:  0x010,
  LEFT:   0x020,
  UP:     0x040,
  DOWN:   0x080,
  R:      0x100,
  L:      0x200,
} as const;

export class LinkdeviceLocalTestSession {

  private subscriptions = new Subscription();
  private packetCounter = 0;
  private verbose = true;

  private sawBlockTransfer = false;
  private lastIntersyncCategory = 0x8000;
  private lastTurnSeq = 0;
  private last3eRotation = 1;

  // Rolling buffer of recent master words. Used to reassemble size-13 cmd-0x3F
  // packets that span multiple USB frames so we can echo the full payload back
  // with the slot bit flipped (see buildSlave3fTurnEchoPacket).
  private rxBuffer: number[] = [];
  private rxBufferMax = 128;
  private lastAckedTurnSeq = -1;

  // Currently-held slot-1 key bits (sum of GBA_KEY values). Updated by browser
  // keydown/keyup listeners. OR'd into INTERSYNC replies so slot 1 "presses"
  // keys synthetically — lets the tester pick a CO and confirm match start
  // via the keyboard.
  private heldKeys = 0;
  private keyListener = (e: KeyboardEvent) => this.onKeyEvent(e);

  constructor(private linkDeviceService: LinkDeviceService) {
    this.subscriptions.add(linkDeviceService.statusEvents$.subscribe(status => {
      console.log('[LocalTest] Status event: ' + LinkStatus[status]);
    }));

    this.subscriptions.add(linkDeviceService.dataEvents$.subscribe(data => {
      this.onIncomingUsbPacket(data);
    }));

    window.addEventListener('keydown', this.keyListener);
    window.addEventListener('keyup', this.keyListener);
    console.log('%c[LocalTest] Slot-1 keyboard active: Z=A, X=B, Enter=START, RShift=SELECT, Arrows=DPad, A=L, S=R',
                'color: #00aa00');
  }

  private onKeyEvent(e: KeyboardEvent) {
    let bit = 0;
    switch (e.key) {
      case 'z': case 'Z':         bit = GBA_KEY.A; break;
      case 'x': case 'X':         bit = GBA_KEY.B; break;
      case 'Enter':               bit = GBA_KEY.START; break;
      case 'Shift':               bit = GBA_KEY.SELECT; break;
      case 'ArrowUp':             bit = GBA_KEY.UP; break;
      case 'ArrowDown':           bit = GBA_KEY.DOWN; break;
      case 'ArrowLeft':           bit = GBA_KEY.LEFT; break;
      case 'ArrowRight':          bit = GBA_KEY.RIGHT; break;
      case 'a': case 'A':         bit = GBA_KEY.L; break;
      case 's': case 'S':         bit = GBA_KEY.R; break;
      default: return;
    }
    if (e.type === 'keydown') {
      if (!(this.heldKeys & bit)) {
        this.heldKeys |= bit;
        console.log(`%c[LocalTest] slot-1 keydown: 0x${bit.toString(16)} (held=0x${this.heldKeys.toString(16)})`,
                    'color: #00aa00');
      }
    } else {
      this.heldKeys &= ~bit;
    }
    e.preventDefault();
  }

  private onIncomingUsbPacket(data: DataArray) {
    const count = Math.min(data[31] ?? 0, 31);
    if (count === 0) return;

    const words = data.slice(0, count);

    if (this.verbose) {
      const hex = words.map(v => (v & 0xFFFF).toString(16).padStart(4, '0')).join(' ');
      console.log(`%c[LocalTest #${this.packetCounter++}] in (n=${count}): ${hex}`,
                  'color: #3366ff');
    }

    // Detect CMD_SYNC stream. When master is in STATE_SYNC it spams CMD_SYNC
    // continuously, waiting for slot 1 to also emit CMD_SYNC. Per gpsp
    // serial_proto.c:492-507, master advances out of STATE_SYNC once it sees
    // slot 1 is also in SYNC state. We reply by flooding CMD_SYNC back as
    // fast as USB allows — the firmware's transmitCallback will feed each
    // one to the GBA's SIO on successive clocks.
    let syncCount = 0;
    for (const w of words) {
      if (w === CMD_SYNC_AW1 || w === CMD_SYNC_AW2) syncCount++;
    }
    if (syncCount >= 2) {
      if (this.verbose) {
        console.log(`%c[LocalTest] ← master CMD_SYNC ×${syncCount} — replying CMD_SYNC burst`,
                    'color: #cc6600; font-weight: bold');
      }
      this.sendSyncBurst(words[0] === CMD_SYNC_AW2 ? CMD_SYNC_AW2 : CMD_SYNC_AW1);
      return;  // don't fall through to the 0x4FFF scan for sync packets
    }

    // INTERSYNC phase (map-select → battle). Master emits key-input halfwords
    // (0x8000-0x9F00) and CMD_NOP. Slave must echo category bits so master
    // doesn't drop the link. Per gpsp serial_proto.c:509-523, reply is:
    //   key input (0x8000-0x9F00) → (value & 0xFC00)
    //   CMD_NOP                   → (lastcmd & 0xFC00)
    // 1:1 word mapping — NOT a 31-word burst. Bursting overshoots master's
    // SIO clock rate, fills the firmware TX queue with stale-category replies,
    // and master reads the wrong category back when it changes (0x8400 → 0x8800)
    // causing an immediate link drop.
    let intersyncCount = 0;
    for (const w of words) {
      if ((w >= INTERSYNC_MIN && w <= INTERSYNC_MAX) || w === CMD_NOP) intersyncCount++;
    }
    if (intersyncCount >= 2) {
      const keys = this.heldKeys;
      const replies: number[] = [];
      for (const w of words) {
        if (w >= INTERSYNC_MIN && w <= INTERSYNC_MAX) {
          this.lastIntersyncCategory = w & 0xFC00;
          replies.push(this.lastIntersyncCategory | keys);
        } else if (w === CMD_NOP) {
          replies.push(this.lastIntersyncCategory | keys);
        } else {
          replies.push(CMD_NONE);
        }
      }
      if (this.verbose) {
        const hex = replies.map(v => v.toString(16).padStart(4,'0')).join(' ');
        console.log(`%c[LocalTest] ← INTERSYNC n=${intersyncCount} — reply: ${hex}`,
                    'color: #aa00aa; font-weight: bold');
      }
      this.sendWords(replies);
      return;
    }

    // Scan for master's packets. For EACH 0x4FFF found, respond appropriately:
    //   Large (>13) block:  send fake slave 0x3B block (69 halfwords)
    //   Small cmd 0x3A:     send fake slave 0x3A
    //   Small cmd 0x3E:     send fake slave 0x3E (rotation ack)
    //   Small cmd 0x3B (small variant): send 0x3B block anyway
    // Don't break after first — a single USB frame may contain multiple
    // master packets and we want to respond to each.
    for (let i = 0; i + 2 < count; i++) {
      if (words[i] !== 0x4FFF) continue;
      const pktSize = words[i + 1] & 0xFF;
      const data0 = words[i + 3] ?? 0;
      const cmdByte = data0 & 0xFF;

      if (pktSize > 13) {
        if (!this.sawBlockTransfer) {
          console.log(`%c[LocalTest] ← master emitted size=0x${pktSize.toString(16)} block — starting slave responses`,
                      'color: #009966; font-weight: bold');
          this.sawBlockTransfer = true;
        }
        this.sendSlaveBlock();
      } else if (pktSize === 2 && cmdByte === 0x3A) {
        console.log(`%c[LocalTest] ← master 0x3A — replying slot-1 0x3A`,
                    'color: #cc6600');
        this.sendSmallPacket(SLAVE_0X3A_PACKET);
      } else if (pktSize === 2 && cmdByte === 0x3E) {
        // Extract master's rotation counter from data[1] if available in the
        // current USB frame (0x3E packet is only 5 words so usually fits).
        // Fall back to last-seen value if split across frames.
        if (i + 4 < count) {
          this.last3eRotation = words[i + 4] & 0xFFFF;
        }
        console.log(`%c[LocalTest] ← master 0x3E rot=${this.last3eRotation} — replying slot-1 0x3E`,
                    'color: #cc6600');
        this.sendSmallPacket(buildSlave3ePacket(this.last3eRotation));
      } else if (pktSize === 0x0D && cmdByte === 0x3F) {
        // Turn-exchange packet. Can't handle in this loop because master's
        // 16-word packet spans USB frames. Handled by accumulateAndScan3f()
        // which runs after this loop completes.
      } else if (pktSize > 0) {
        console.log(`%c[LocalTest] ← unhandled small cmd size=${pktSize} data[0]=0x${data0.toString(16).padStart(4,'0')}`,
                    'color: #666666');
      }
    }

    // Cross-frame 0x3F accumulator. Master's size=13 cmd=0x3F packet is
    // 16 words and usually spans 3 USB frames. Track it in a rolling
    // buffer; when a complete packet is found, reply with the full echo.
    this.accumulateAndScan3f(words);
  }

  private accumulateAndScan3f(words: number[]) {
    for (const w of words) this.rxBuffer.push(w & 0xFFFF);
    if (this.rxBuffer.length > this.rxBufferMax) {
      this.rxBuffer = this.rxBuffer.slice(-this.rxBufferMax);
    }

    // Scan for complete size-13 cmd-0x3F packets in the rolling buffer.
    // packet[0]=0x4FFF, packet[1]=0x000D, packet[3]&0xFF === 0x3F.
    let i = 0;
    while (i + 16 <= this.rxBuffer.length) {
      if (this.rxBuffer[i] === 0x4FFF &&
          this.rxBuffer[i + 1] === 0x000D &&
          (this.rxBuffer[i + 3] & 0xFF) === 0x3F) {
        const packet = this.rxBuffer.slice(i, i + 16);
        const seq = packet[4];
        const reply = buildSlave3fTurnPacket(seq);
        if (seq !== this.lastAckedTurnSeq) {
          // Log full master packet on seq change for decomp analysis
          const hex = packet.map(v => v.toString(16).padStart(4, '0')).join(' ');
          console.log(`%c[LocalTest] ← master cmd=0x3F seq=${seq} full: ${hex}`,
                      'color: #0066cc; font-weight: bold');
          this.lastAckedTurnSeq = seq;
        }
        this.sendSmallPacket(reply);
        // Consume buffer up to and including this packet
        this.rxBuffer = this.rxBuffer.slice(i + 16);
        i = 0;
        continue;
      }
      i++;
    }
  }

  // Fill a 64-byte USB packet with the given halfword value 31 times,
  // so the firmware enqueues 31 identical halfwords for playback to the
  // master GBA on 31 successive SIO clocks.
  private sendSyncBurst(value: number) {
    const chunk: number[] = new Array(31).fill(value);
    chunk.push(31);  // word 31 = count
    this.linkDeviceService.sendData(chunk as unknown as DataArray).then(
      ok => { if (!ok) console.warn('[LocalTest] sendSyncBurst failed'); },
      err => { console.error('[LocalTest] sendSyncBurst error', err); }
    );
  }

  // Send an arbitrary sequence of halfwords as a single USB packet. The
  // firmware will feed them one per SIO clock. Caller must ensure length ≤ 31.
  private sendWords(pkt: number[]) {
    const chunk: number[] = [...pkt];
    while (chunk.length < 31) chunk.push(0);
    chunk.push(pkt.length);
    this.linkDeviceService.sendData(chunk as unknown as DataArray).then(
      ok => { if (!ok) console.warn('[LocalTest] sendWords failed'); },
      err => { console.error('[LocalTest] sendWords error', err); }
    );
  }

  private sendSmallPacket(pkt: number[]) {
    const chunk: number[] = [...pkt];
    while (chunk.length < 31) chunk.push(0);
    chunk.push(pkt.length);
    this.linkDeviceService.sendData(chunk as unknown as DataArray).then(
      ok => { if (!ok) console.warn('[LocalTest] sendSmallPacket failed'); },
      err => { console.error('[LocalTest] sendSmallPacket error', err); }
    );
  }

  // Send a fake slave 0x3B block (69 halfwords) split across 3 USB packets.
  // Each packet has up to 31 useful halfwords plus word[31]=count.
  private sendSlaveBlock() {
    const block: number[] = [SLAVE_BLOCK_HEADER, SLAVE_BLOCK_SIZE, SLAVE_BLOCK_CKSUM, SLAVE_BLOCK_DATA0];
    while (block.length < 69) block.push(0);

    // Split into chunks of 31, with the tail chunk padded
    const chunkSize = 31;
    for (let offset = 0; offset < block.length; offset += chunkSize) {
      const chunk = block.slice(offset, offset + chunkSize);
      const actualCount = chunk.length;
      // Pad to 31 real-data slots
      while (chunk.length < 31) chunk.push(0);
      // Word 31 = count
      chunk.push(actualCount);
      this.linkDeviceService.sendData(chunk as unknown as DataArray).then(
        ok => { if (!ok) console.warn('[LocalTest] sendData returned false'); },
        err => { console.error('[LocalTest] sendData error', err); }
      );
    }
  }

  destroy() {
    this.subscriptions.unsubscribe();
    window.removeEventListener('keydown', this.keyListener);
    window.removeEventListener('keyup', this.keyListener);
  }
}
