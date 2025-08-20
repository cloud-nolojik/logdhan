/**
 * Base messaging provider class
 */
export class MessagingProvider {
  constructor(config) {
    this.config = config;
  }

  async initialize() {
    throw new Error('initialize() method must be implemented');
  }

  async sendMessage() {
    throw new Error('sendMessage() method must be implemented');
  }
}