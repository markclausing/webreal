/**
 * The same game on a phone.
 *
 * Two thumbs and no keyboard, so: the left half of the picture is a stick that
 * appears wherever it is first touched and walks you about, the right half is
 * the aim, and the buttons that have to be pressed at the same time as both of
 * those - fire, jump, weapon - are along the bottom right where a thumb already
 * is.
 *
 * The look is the hard part. A stick would be miserable, so dragging the right
 * side turns the view directly, at the same units per centimetre a mouse gets,
 * and a short tap in that half fires: on a phone the thing you most want after
 * pointing at somebody is to shoot them, and reaching for a button loses the aim.
 */

import { BTN, PITCH_LIMIT, YAW_UNITS } from './constants.js';
import { wrapYaw } from './input.js';

export class Touch {
  constructor(root, canvas) {
    this.root = root;
    this.canvas = canvas;
    this.enabled = false;
    this.moveId = null;
    this.lookId = null;
    this.moveFrom = { x: 0, y: 0 };
    this.moveAt = { x: 0, y: 0 };
    this.lookAt = { x: 0, y: 0 };
    this.lookStart = 0;
    this.lookMoved = 0;
    this.tapFire = 0;
    this.buttons = new Set();
    this.sensitivity = 1;

    this.stick = root.querySelector('#stick');
    this.knob = root.querySelector('#knob');

    for (const el of root.querySelectorAll('[data-touch]')) {
      const action = el.dataset.touch;
      const press = (on) => (e) => {
        e.preventDefault();
        if (on) this.buttons.add(action); else this.buttons.delete(action);
        el.classList.toggle('held', on);
      };
      el.addEventListener('pointerdown', press(true));
      el.addEventListener('pointerup', press(false));
      el.addEventListener('pointercancel', press(false));
      el.addEventListener('pointerleave', press(false));
    }

    this.onDown = (e) => this.down(e);
    this.onMove = (e) => this.move(e);
    this.onUp = (e) => this.up(e);
  }

  /** Is this a machine that wants thumbs? Asked once, and overridable. */
  static wanted() {
    if (typeof window === 'undefined') return false;
    const coarse = window.matchMedia?.('(pointer: coarse)')?.matches;
    const touch = navigator.maxTouchPoints > 0;
    return !!(coarse && touch);
  }

  attach() {
    this.enabled = true;
    this.root.classList.remove('hidden');
    this.canvas.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove, { passive: false });
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onUp);
  }

  detach() {
    this.enabled = false;
    this.root.classList.add('hidden');
    this.canvas.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    window.removeEventListener('pointercancel', this.onUp);
    this.moveId = null;
    this.lookId = null;
    this.buttons.clear();
  }

  down(e) {
    if (!this.enabled) return;
    const half = window.innerWidth / 2;
    if (e.clientX < half && this.moveId === null) {
      this.moveId = e.pointerId;
      this.moveFrom = { x: e.clientX, y: e.clientY };
      this.moveAt = { x: e.clientX, y: e.clientY };
      if (this.stick) {
        this.stick.style.left = `${e.clientX}px`;
        this.stick.style.top = `${e.clientY}px`;
        this.stick.classList.add('on');
      }
      e.preventDefault();
    } else if (e.clientX >= half && this.lookId === null) {
      this.lookId = e.pointerId;
      this.lookAt = { x: e.clientX, y: e.clientY };
      this.lookStart = performance.now();
      this.lookMoved = 0;
      e.preventDefault();
    }
  }

  move(e) {
    if (!this.enabled) return;
    if (e.pointerId === this.moveId) {
      this.moveAt = { x: e.clientX, y: e.clientY };
      if (this.knob) {
        const dx = Math.max(-46, Math.min(46, e.clientX - this.moveFrom.x));
        const dy = Math.max(-46, Math.min(46, e.clientY - this.moveFrom.y));
        this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
      }
      e.preventDefault();
    } else if (e.pointerId === this.lookId) {
      const dx = e.clientX - this.lookAt.x;
      const dy = e.clientY - this.lookAt.y;
      this.lookAt = { x: e.clientX, y: e.clientY };
      this.lookMoved += Math.abs(dx) + Math.abs(dy);
      this.dyaw = (this.dyaw || 0) - dx;
      this.dpitch = (this.dpitch || 0) - dy;
      e.preventDefault();
    }
  }

  up(e) {
    if (e.pointerId === this.moveId) {
      this.moveId = null;
      if (this.stick) this.stick.classList.remove('on');
      if (this.knob) this.knob.style.transform = 'translate(0px, 0px)';
    } else if (e.pointerId === this.lookId) {
      // A tap rather than a drag: fire once, for two frames, so a single tick
      // of the simulation cannot miss it.
      if (this.lookMoved < 14 && performance.now() - this.lookStart < 260) this.tapFire = 3;
      this.lookId = null;
    }
  }

  /** Fold the thumbs into the mask the game reads. Called from Input.read. */
  apply(input, mask) {
    if (!this.enabled) return mask;

    if (this.moveId !== null) {
      const dx = this.moveAt.x - this.moveFrom.x;
      const dy = this.moveAt.y - this.moveFrom.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len > 12) {
        const nx = dx / len;
        const ny = dy / len;
        if (ny < -0.4) mask |= BTN.FWD;
        if (ny > 0.4) mask |= BTN.BACK;
        if (nx < -0.4) mask |= BTN.LEFT;
        if (nx > 0.4) mask |= BTN.RIGHT;
      }
    }

    const k = this.sensitivity * (YAW_UNITS / 360) * 0.10;
    if (this.dyaw) {
      input.yaw = wrapYaw(input.yaw + this.dyaw * k);
      this.dyaw = 0;
    }
    if (this.dpitch) {
      input.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, input.pitch + this.dpitch * k));
      this.dpitch = 0;
    }

    if (this.buttons.has('fire')) mask |= BTN.FIRE;
    if (this.buttons.has('jump')) mask |= BTN.JUMP;
    if (this.buttons.has('next')) mask |= BTN.NEXT;
    if (this.tapFire > 0) {
      mask |= BTN.FIRE;
      this.tapFire--;
    }
    // A button is a press, not a hold: taking the finger off is what ends it,
    // and NEXT held down would cycle the whole rack in a fifth of a second.
    this.buttons.delete('next');
    return mask;
  }
}
