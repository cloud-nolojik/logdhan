import express from 'express';
const router = express.Router();

/**
 * App redirect handler for WhatsApp deep links
 * Routes like https://logdhan.com/app/analysis/completed
 * Will show a page that attempts to open the app
 */

router.get('/analysis/completed', (req, res) => {
  const userAgent = req.get('User-Agent') || '';
  const isMobile = /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(userAgent);
  
  console.log(`🔗 Deep link accessed: /app/analysis/completed`);
  console.log(`📱 User Agent: ${userAgent.substring(0, 100)}...`);
  console.log(`📱 Is Mobile: ${isMobile}`);
  
  if (isMobile) {
    // Mobile device - try to open app with fallback
    res.send(generateMobileRedirectHTML());
  } else {
    // Desktop - show app download page
    res.send(generateDesktopHTML());
  }
});

function generateMobileRedirectHTML() {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Opening LogDhan App...</title>
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
    <div class="description">Your analysis is ready to view!</div>
    <div class="loading">If the app doesn't open automatically:</div>
    <a href="https://play.google.com/store/apps/details?id=com.nolojik.logdhan" class="button">Download App</a>
  </div>

  <script>
    // Try to open the app using custom scheme first
    window.location.href = 'logdhan://app/analysis/completed';
    
    // If that doesn't work, try with logdhanapp scheme 
    setTimeout(() => {
      window.location.href = 'logdhanapp://analysis/completed';
    }, 1000);
    
    // Fallback to app store after 3 seconds
    setTimeout(() => {
      if (!document.hidden) {
        console.log('📱 Redirecting to app store');
        window.location.href = 'https://play.google.com/store/apps/details?id=com.nolojik.logdhan';
      }
    }, 3000);
  </script>
</body>
</html>`;
}

function generateDesktopHTML() {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LogDhan - Analysis Complete</title>
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
    .download-btn {
      display: inline-block;
      padding: 15px 25px;
      background: white;
      color: #764ba2;
      text-decoration: none;
      border-radius: 15px;
      font-weight: 600;
      transition: transform 0.2s;
      margin: 10px;
    }
    .download-btn:hover {
      transform: scale(1.05);
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">📊</div>
    <div class="title">Analysis Complete!</div>
    <div class="description">Your bulk analysis is ready to view. Download the LogDhan mobile app to see your results:</div>
    
    <a href="https://play.google.com/store/apps/details?id=com.nolojik.logdhan" class="download-btn">
      📱 Get on Android
    </a>
    <a href="https://apps.apple.com/app/logdhan/" class="download-btn">
      🍎 Get on iOS
    </a>
  </div>
</body>
</html>`;
}

export default router;