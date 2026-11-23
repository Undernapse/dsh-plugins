/**
 * Host half of the tracker issue workflow bundle.
 *
 * The feature is entirely in the browser: `client.js` registers the
 * right-click menu on issue links and starts a Session command. The Host row
 * exists so the bundle's Client half loads, and it holds no state. Tracker
 * hosts are recognised from the link itself, so there is no instance to
 * configure here.
 */
export function apply() {}
