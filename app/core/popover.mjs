// Menus anchored to a chip (model picker, mode picker), on Floating UI
// (@floating-ui/dom, MIT): opens above the chip, flips below when there is no
// room, shifts to stay on screen, caps its height to the space available, and
// follows the chip on scroll, resize and layout shifts until the menu hides.
import { autoUpdate, computePosition, flip, offset, shift, size } from '@floating-ui/dom';

const PAD = 8;
const tracking = new WeakMap();

/** Show `menu` anchored to `anchor`; it stops tracking once `menu.hidden` is set again. */
export function anchorMenu(menu, anchor) {
  tracking.get(menu)?.();
  menu.hidden = false;
  const update = () => computePosition(anchor, menu, {
    strategy: 'fixed',
    placement: 'top-start',
    middleware: [
      offset(PAD),
      flip({ padding: PAD, fallbackPlacements: ['bottom-start', 'top-end', 'bottom-end'] }),
      shift({ padding: PAD }),
      size({ padding: PAD, apply({ availableHeight }) { menu.style.setProperty('--menu-max', Math.max(120, Math.floor(availableHeight)) + 'px'); } })
    ]
  }).then(({ x, y }) => { menu.style.left = x + 'px'; menu.style.top = y + 'px'; });
  const stopUpdates = autoUpdate(anchor, menu, update);
  const watch = new MutationObserver(() => { if (menu.hidden) stop(); });
  const stop = () => { stopUpdates(); watch.disconnect(); tracking.delete(menu); };
  watch.observe(menu, { attributes: true, attributeFilter: ['hidden'] });
  tracking.set(menu, stop);
}
