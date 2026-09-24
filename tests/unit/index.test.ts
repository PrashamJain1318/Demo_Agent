import { describe, expect, it } from 'vitest';
import { APP_NAME, APP_VERSION, getAppInfo } from '../../src/index.js';

describe('Digital Janitor Foundation', () => {
  it('should return app info with foundation status', () => {
    const info = getAppInfo();
    expect(info.name).toBe(APP_NAME);
    expect(info.version).toBe(APP_VERSION);
    expect(info.status).toBe('foundation-initialized');
  });
});
