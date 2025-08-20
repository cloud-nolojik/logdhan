import express from 'express';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

// Test chart generation endpoint
router.get('/test-chart', async (req, res) => {
  try {
    console.log('🧪 Testing QuickChart.io API...');
    
    // Ultra-simple test chart configuration that should definitely work
    const testChartConfig = {
      type: 'bar',
      data: {
        labels: ['A', 'B', 'C'],
        datasets: [{
          data: [1, 2, 3],
          backgroundColor: '#ff6384'
        }]
      }
    };

    console.log('📊 Sending test chart config to QuickChart.io');

    // Try multiple chart services
    let response;
    let serviceUsed = '';
    
    try {
      // Try QuickChart.io first
      console.log('🌐 Trying QuickChart.io...');
      response = await axios.post('https://quickchart.io/chart', {
        chart: testChartConfig,
        width: 400,
        height: 200,
        format: 'png'
      }, {
        responseType: 'arraybuffer',
        timeout: 15000
      });
      serviceUsed = 'QuickChart.io';
      
    } catch (quickchartError) {
      console.log('❌ QuickChart.io failed:', quickchartError.message);
      
      try {
        // Try Chart.js Image API as backup
        console.log('🌐 Trying Chart.js Image API...');
        const chartUrl = `https://chart-image.com/chart?data=${encodeURIComponent(JSON.stringify(testChartConfig))}&width=400&height=200`;
        response = await axios.get(chartUrl, {
          responseType: 'arraybuffer',
          timeout: 15000
        });
        serviceUsed = 'Chart.js Image API';
        
      } catch (chartjsError) {
        console.log('❌ Chart.js Image API also failed:', chartjsError.message);
        throw new Error('All chart services failed');
      }
    }

    console.log(`✅ ${serviceUsed} response status:`, response.status);
    console.log('📊 Test chart image size:', response.data.length, 'bytes');

    // Save the test chart
    const chartDir = path.join(process.cwd(), 'temp', 'charts');
    if (!fs.existsSync(chartDir)) {
      fs.mkdirSync(chartDir, { recursive: true });
    }

    const fileName = `test-${uuidv4()}.png`;
    const filePath = path.join(chartDir, fileName);
    
    fs.writeFileSync(filePath, response.data);
    
    const backendUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 5650}`;
    const chartUrl = `${backendUrl}/charts/${fileName}`;

    console.log('✅ Test chart saved and available at:', chartUrl);

    res.json({
      success: true,
      message: 'Test chart generated successfully',
      chartUrl: chartUrl,
      fileName: fileName,
      imageSize: response.data.length
    });

  } catch (error) {
    console.error('❌ Test chart generation failed:', error.message);
    console.error('Error details:', error.response?.data || error.stack);
    
    res.status(500).json({
      success: false,
      error: 'Test chart generation failed',
      details: error.message
    });
  }
});

export default router;