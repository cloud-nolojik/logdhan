import express from 'express';
const router = express.Router();

/**
 * Universal app link handler for logdhan.com
 * Handles deep links from WhatsApp templates
 */

// App store URLs - update these with your actual app store links
const APP_STORE_URLS = {
  android: 'https://play.google.com/store/apps/details?id=com.nolojik.logdhan',
  ios: 'https://apps.apple.com/app/logdhan/id123456789', // Update with actual App Store ID
  web: 'https://logdhan.com' // Fallback to website
};

// Deep link schemes for mobile apps
const DEEP_LINK_SCHEMES = {
  android: 'logdhan://app',
  ios: 'logdhan://app'
};

/**
 * Analysis deep link handler
 * URL: https://logdhan.com/analysis/{stockSymbol}
 */
router.get('/analysis/:stockSymbol?', (req, res) => {
  const { stockSymbol } = req.params;
  const userAgent = req.get('User-Agent') || '';
  
  const deepLinkPath = stockSymbol ? `/analysis/${stockSymbol}` : '/analysis';
  
  handleDeepLink(req, res, deepLinkPath, {
    title: 'LogDhan Analysis',
    description: stockSymbol ? `View analysis for ${stockSymbol}` : 'View your trading analysis',
    section: 'analysis',
    param: stockSymbol
  });
});

/**
 * Subscription deep link handler
 * URL: https://logdhan.com/subscription/{action}
 */
router.get('/subscription/:action?', (req, res) => {
  const { action } = req.params;
  const deepLinkPath = action ? `/subscription/${action}` : '/subscription';
  
  handleDeepLink(req, res, deepLinkPath, {
    title: 'LogDhan Subscription',
    description: 'Manage your LogDhan subscription',
    section: 'subscription',
    param: action
  });
});

/**
 * Profile deep link handler
 * URL: https://logdhan.com/profile/{section}
 */
router.get('/profile/:section?', (req, res) => {
  const { section } = req.params;
  const deepLinkPath = section ? `/profile/${section}` : '/profile';
  
  handleDeepLink(req, res, deepLinkPath, {
    title: 'LogDhan Profile',
    description: 'Manage your LogDhan account',
    section: 'profile',
    param: section
  });
});

/**
 * Watchlist deep link handler
 * URL: https://logdhan.com/watchlist
 */
router.get('/watchlist', (req, res) => {
  handleDeepLink(req, res, '/watchlist', {
    title: 'LogDhan Watchlist',
    description: 'View your stock watchlist',
    section: 'watchlist'
  });
});

/**
 * Dashboard deep link handler
 * URL: https://logdhan.com/dashboard
 */
router.get('/dashboard', (req, res) => {
  handleDeepLink(req, res, '/dashboard', {
    title: 'LogDhan Dashboard',
    description: 'View your trading dashboard',
    section: 'dashboard'
  });
});

/**
 * Generic app deep link handler
 * URL: https://logdhan.com/app/{section}/{param}
 */
router.get('/app/:section/:param?', (req, res) => {
  const { section, param } = req.params;
  const deepLinkPath = param ? `/app/${section}/${param}` : `/app/${section}`;
  
  handleDeepLink(req, res, deepLinkPath, {
    title: 'LogDhan App',
    description: 'Open LogDhan mobile app',
    section,
    param
  });
});

/**
 * Main deep link handler function
 */
function handleDeepLink(req, res, deepLinkPath, metadata) {
  const userAgent = req.get('User-Agent') || '';
  const isAndroid = /Android/i.test(userAgent);
  const isIOS = /iPad|iPhone|iPod/.test(userAgent);
  const isMobile = isAndroid || isIOS;
  
  // Generate deep link URLs
  const androidDeepLink = `${DEEP_LINK_SCHEMES.android}${deepLinkPath}`;
  const iosDeepLink = `${DEEP_LINK_SCHEMES.ios}${deepLinkPath}`;
  
  console.log(`🔗 Deep link request: ${req.originalUrl}`);
  console.log(`📱 User Agent: ${userAgent.substring(0, 100)}...`);
  console.log(`🎯 Target: ${metadata.section}${metadata.param ? `/${metadata.param}` : ''}`);
  
  if (isMobile) {
    // Mobile device - try to open app, fallback to app store
    const deepLink = isAndroid ? androidDeepLink : iosDeepLink;
    const storeUrl = isAndroid ? APP_STORE_URLS.android : APP_STORE_URLS.ios;
    
    res.send(generateMobileRedirectHTML(deepLink, storeUrl, metadata));
  } else {
    // Desktop - show download page
    res.send(generateDesktopHTML(metadata));
  }
}

/**
 * Generate HTML for mobile redirect with app detection
 */
function generateMobileRedirectHTML(deepLink, storeUrl, metadata) {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${metadata.title}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      margin: 0;
      padding: 20px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      text-align: center;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      justify-content: center;
    }
    .container {
      max-width: 400px;
      margin: 0 auto;
      background: rgba(255,255,255,0.1);
      padding: 30px;
      border-radius: 20px;
      backdrop-filter: blur(10px);
    }
    .logo {
      font-size: 2.5em;
      margin-bottom: 20px;
    }
    .title {
      font-size: 1.5em;
      margin-bottom: 10px;
      font-weight: 600;
    }
    .description {
      margin-bottom: 30px;
      opacity: 0.9;
    }
    .button {
      display: inline-block;
      padding: 15px 30px;
      background: white;
      color: #764ba2;
      text-decoration: none;
      border-radius: 25px;
      font-weight: 600;
      margin: 10px;
      transition: transform 0.2s;
    }
    .button:hover {
      transform: scale(1.05);
    }
    .loading {
      margin-top: 20px;
      font-size: 0.9em;
      opacity: 0.8;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">📊</div>
    <div class="title">Opening LogDhan...</div>
    <div class="description">${metadata.description}</div>
    <div class="loading">If the app doesn't open automatically:</div>
    <a href="${storeUrl}" class="button">Download App</a>
  </div>

  <script>
    // Attempt to open the app
    let opened = false;
    
    function tryOpenApp() {
      if (!opened) {
        opened = true;
        console.log('🚀 Attempting to open app:', '${deepLink}');
        window.location.href = '${deepLink}';
        
        // Fallback to app store after 2 seconds if app doesn't open
        setTimeout(() => {
          if (!document.hidden) {
            console.log('📱 Redirecting to app store:', '${storeUrl}');
            window.location.href = '${storeUrl}';
          }
        }, 2000);
      }
    }
    
    // Try to open app immediately
    tryOpenApp();
    
    // Also try when page becomes visible (in case user switches tabs)
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !opened) {
        tryOpenApp();
      }
    });
  </script>
</body>
</html>`;
}

/**
 * Generate HTML for desktop users
 */
function generateDesktopHTML(metadata) {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${metadata.title}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      margin: 0;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container {
      text-align: center;
      max-width: 500px;
      padding: 50px;
      background: rgba(255,255,255,0.1);
      border-radius: 20px;
      backdrop-filter: blur(10px);
    }
    .logo {
      font-size: 4em;
      margin-bottom: 30px;
    }
    .title {
      font-size: 2.5em;
      margin-bottom: 20px;
      font-weight: 600;
    }
    .description {
      font-size: 1.2em;
      margin-bottom: 40px;
      opacity: 0.9;
    }
    .download-buttons {
      display: flex;
      gap: 20px;
      justify-content: center;
      flex-wrap: wrap;
    }
    .download-btn {
      display: flex;
      align-items: center;
      padding: 15px 25px;
      background: white;
      color: #764ba2;
      text-decoration: none;
      border-radius: 15px;
      font-weight: 600;
      transition: transform 0.2s;
      min-width: 140px;
    }
    .download-btn:hover {
      transform: scale(1.05);
    }
    .download-btn img {
      width: 24px;
      height: 24px;
      margin-right: 10px;
    }
    .web-link {
      margin-top: 30px;
    }
    .web-link a {
      color: white;
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">📊</div>
    <div class="title">LogDhan Trading App</div>
    <div class="description">${metadata.description}</div>
    <div class="description">Download the LogDhan mobile app to access this content:</div>
    
    <div class="download-buttons">
      <a href="${APP_STORE_URLS.android}" class="download-btn">
        📱 Get on Android
      </a>
      <a href="${APP_STORE_URLS.ios}" class="download-btn">
        🍎 Get on iOS
      </a>
    </div>
    
    <div class="web-link">
      <p>Or visit <a href="${APP_STORE_URLS.web}">logdhan.com</a> on mobile</p>
    </div>
  </div>
</body>
</html>`;
}

export default router;