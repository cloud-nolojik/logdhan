/**
 * Kite Order Events — EventEmitter singleton for order status updates.
 *
 * Postback handler emits events here; business logic (daily picks fill listener,
 * swing order sync, etc.) subscribes without coupling to the HTTP route.
 *
 * Events:
 *   order:complete  — Order filled   (postback.status === 'COMPLETE')
 *   order:rejected  — Order rejected (postback.status === 'REJECTED')
 *   order:cancelled — Order cancelled (postback.status === 'CANCELLED')
 */

import { EventEmitter } from 'events';

class KiteOrderEvents extends EventEmitter {}

const kiteOrderEvents = new KiteOrderEvents();

export default kiteOrderEvents;
