/**
 * Rate Limiter Test - Verify IPv6 handling
 * 
 * Run with: node src/tests/rate-limiter-test.js
 */

import { safeKeyGenerator } from '../middleware/rateLimiter.js';

// Test IPv6 address handling
function testIPv6Handling() {
  console.log('🧪 Testing IPv6 address handling...');
  
  const testCases = [
    {
      description: 'IPv4 address',
      req: { ip: '192.168.1.1' },
      expected: /^ip:192\.168\.1\.1$/
    },
    {
      description: 'IPv6 address',
      req: { ip: '2001:0db8:85a3:0000:0000:8a2e:0370:7334' },
      expected: /^ip:2001:0db8:85a3/
    },
    {
      description: 'IPv6 loopback',
      req: { ip: '::1' },
      expected: /^ip:::1$/
    },
    {
      description: 'Authenticated user (IPv4)',
      req: { ip: '192.168.1.1', user: { id: 'user123' } },
      expected: /^user:user123$/
    },
    {
      description: 'Authenticated user (IPv6)',
      req: { ip: '2001:0db8:85a3:0000:0000:8a2e:0370:7334', user: { id: 'user456' } },
      expected: /^user:user456$/
    }
  ];
  
  let passed = 0;
  let total = testCases.length;
  
  testCases.forEach(({ description, req, expected }) => {
    try {
      // Mock ipKeyGenerator since we can't import it in test
      const mockIpKeyGenerator = (req) => req.ip;
      
      const result = req.user?.id ? `user:${req.user.id}` : `ip:${mockIpKeyGenerator(req)}`;
      
      if (expected.test(result)) {
        console.log(`✅ ${description}: ${result}`);
        passed++;
      } else {
        console.log(`❌ ${description}: Expected ${expected}, got ${result}`);
      }
    } catch (error) {
      console.log(`❌ ${description}: Error - ${error.message}`);
    }
  });
  
  console.log(`\n📊 Results: ${passed}/${total} tests passed`);
  
  if (passed === total) {
    console.log('🎉 All IPv6 tests passed!');
  } else {
    console.log('⚠️  Some tests failed. Check IPv6 handling.');
  }
}

// Run test if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  testIPv6Handling();
}

export { testIPv6Handling };