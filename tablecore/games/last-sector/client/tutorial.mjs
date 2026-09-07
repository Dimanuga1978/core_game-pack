'use strict';

import { createAssetIcon, assetName } from './assets.mjs';

/** Game-specific tutorial presentation. It simulates the rules on a dedicated
 * presentation board; it never touches authoritative engine state. */
export class LastSectorTutorialDemo {
  constructor(root, options = {}) {
    this.root = root;
    this.camera = options.camera || null;
    this.document = root?.ownerDocument || document;
    this.refs = {};
    this.timers = new Set();
    this.build();
  }

  build() {
    this.root.replaceChildren();
    this.root.classList.add('ls-tutorial-scene');
    const world = this.document.createElement('div');
    world.className = 'ls-tutorial-world';
    const board = this.document.createElement('div');
    board.className = 'ls-tutorial-board';
    for (let r = 0; r < 5; r += 1) {
      for (let q = 0; q < 7; q += 1) {
        const cell = this.document.createElement('div');
        cell.className = 'ls-tutorial-hex';
        cell.dataset.coord = `${q},${r}`;
        board.appendChild(cell);
      }
    }
    const base = this.document.createElement('div'); base.className='ls-tutorial-base'; base.appendChild(createAssetIcon(this.document,'base',{className:'ls-asset'}));
    const ship = this.document.createElement('div'); ship.className='ls-tutorial-ship'; ship.appendChild(createAssetIcon(this.document,'scout',{className:'ls-asset'}));
    const enemy = this.document.createElement('div'); enemy.className='ls-tutorial-enemy'; enemy.appendChild(createAssetIcon(this.document,'pirate',{className:'ls-asset'}));
    const resource = this.document.createElement('div'); resource.className='ls-tutorial-resource'; resource.textContent='◆ GOLD';
    const reveal = this.document.createElement('div'); reveal.className='ls-tutorial-reveal'; reveal.textContent='SECTOR REVEALED';
    const hit = this.document.createElement('div'); hit.className='ls-tutorial-hit'; hit.textContent='IMPACT';
    const route = this.document.createElement('div'); route.className='ls-tutorial-route';
    const title = this.document.createElement('div'); title.className='ls-tutorial-caption';
    world.append(board, route, base, ship, enemy, resource, reveal, hit, title);
    this.root.appendChild(world);
    this.refs = { world, board, base, ship, enemy, resource, reveal, hit, route, title };
    this.reset();
  }

  reset() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    if (!this.refs.world) return;
    for (const [key, node] of Object.entries(this.refs)) {
      if (node?.classList) node.classList.remove('is-active','is-visible','is-hit','is-moving','is-revealed');
    }
    this.refs.title.textContent = '';
    this.refs.resource.textContent = '◆ GOLD';
    this.setPos(this.refs.base, 8, 74);
    this.setPos(this.refs.ship, 34, 54);
    this.setPos(this.refs.enemy, 67, 46);
    this.setPos(this.refs.resource, 67, 46);
  }

  setPos(node, x, y) {
    node.style.left = `${x}%`;
    node.style.top = `${y}%`;
  }

  wait(ms, fn) {
    const t = setTimeout(() => { this.timers.delete(t); fn(); }, Math.max(0, ms));
    this.timers.add(t);
  }

  play(step) {
    this.reset();
    const demo = step?.demo || {};
    const type = demo.type || step?.id || 'map';
    this.refs.title.textContent = step?.title || '';
    this.camera?.reset({ duration: 0 });
    if (demo.camera && this.camera) this.camera.focus(demo.camera, { scale: demo.camera.scale, duration: 420 });
    if (Array.isArray(demo.choreography) && this.camera) this.camera.choreograph(demo.choreography, { duration: demo.choreographyDurationMs });
    switch (type) {
      case 'goal': return this.goal();
      case 'map': return this.map();
      case 'move': return this.move();
      case 'discovery': return this.discovery();
      case 'combat': return this.combat();
      case 'loot': return this.loot();
      case 'victory': return this.victory();
      default: return this.map();
    }
  }

  goal() {
    this.refs.base.classList.add('is-visible');
    this.refs.ship.classList.add('is-visible');
    this.wait(700, () => this.refs.base.classList.add('is-active'));
    this.wait(1500, () => this.refs.title.textContent = 'EXPLORE → SURVIVE → DELIVER');
  }

  map() {
    this.refs.ship.classList.add('is-visible');
    this.wait(700, () => this.refs.ship.classList.add('is-active'));
    this.wait(1400, () => {
      const unknown = [...this.refs.board.children].slice(16, 20);
      unknown.forEach(c => c.classList.add('is-revealed'));
      this.refs.reveal.classList.add('is-visible');
    });
  }

  move() {
    this.refs.ship.classList.add('is-visible');
    this.refs.route.classList.add('is-visible');
    this.wait(450, () => {
      this.refs.ship.classList.add('is-moving');
      this.setPos(this.refs.ship, 58, 47);
    });
    this.wait(1800, () => this.refs.ship.classList.remove('is-moving'));
    this.wait(2200, () => this.refs.route.classList.remove('is-visible'));
  }

  discovery() {
    this.refs.ship.classList.add('is-visible');
    this.wait(500, () => {
      this.refs.reveal.classList.add('is-visible');
      [...this.refs.board.children].slice(23, 26).forEach(c => c.classList.add('is-revealed'));
    });
    this.wait(1500, () => {
      this.refs.resource.classList.add('is-visible');
      this.refs.resource.textContent = 'MINERAL • PUBLIC';
    });
  }

  combat() {
    this.refs.ship.classList.add('is-visible');
    this.refs.enemy.classList.add('is-visible');
    this.wait(650, () => {
      this.refs.enemy.classList.add('is-active');
      this.refs.ship.classList.add('is-active');
    });
    this.wait(1600, () => this.refs.hit.classList.add('is-hit'));
    this.wait(2200, () => this.refs.enemy.classList.add('is-hit'));
    this.wait(2900, () => { this.refs.hit.classList.remove('is-hit'); this.refs.enemy.classList.remove('is-hit'); });
  }

  loot() {
    this.refs.ship.classList.add('is-visible');
    this.refs.resource.classList.add('is-visible');
    this.refs.resource.textContent = '◆ GOLD • EXPLORER KNOWLEDGE';
    this.wait(750, () => this.refs.resource.classList.add('is-active'));
  }

  victory() {
    this.refs.base.classList.add('is-visible');
    this.refs.ship.classList.add('is-visible');
    this.wait(400, () => { this.refs.ship.classList.add('is-moving'); this.setPos(this.refs.ship, 12, 70); });
    this.wait(1900, () => { this.refs.ship.classList.remove('is-moving'); this.refs.base.classList.add('is-active'); });
    this.wait(2500, () => { this.refs.title.textContent = 'DELIVER CARGO • SCORE • WIN'; });
  }

  clear() { this.reset(); this.camera?.reset({ duration: 220 }); }
}
