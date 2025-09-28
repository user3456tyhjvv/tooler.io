            // test-tracking.js
            const fetch = require('node-fetch');

            async function testTracking() {
                const baseUrl = 'http://localhost:3001';
                const domain = 'tiffad.co.ke';
                
                console.log('🧪 Starting tracking tests...\n');

                // Test 1: Send multiple tracking events
                for (let i = 1; i <= 5; i++) {
                    const visitorId = `test-visitor-${i}-${Date.now()}`;
                    
                    const trackData = {
                        siteId: domain,
                        visitorId: visitorId,
                        path: `/test-page-${i}`,
                        referrer: 'https://test.com',
                        screenWidth: 1920,
                        screenHeight: 1080,
                        language: 'en-US',
                        timezone: 'UTC',
                        eventType: 'pageview',
                        timestamp: Date.now()
                    };

                    try {
                        const response = await fetch(`${baseUrl}/track`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify(trackData)
                        });

                        console.log(`✅ Event ${i} sent:`, response.status);
                        
                        // Small delay between requests
                        await new Promise(resolve => setTimeout(resolve, 500));
                    } catch (error) {
                        console.log(`❌ Event ${i} failed:`, error.message);
                    }
                }

                // Test 2: Check stats after tracking
                console.log('\n📊 Checking stats after tracking...');
                try {
                    const statsResponse = await fetch(`${baseUrl}/api/stats/${domain}`);
                    const stats = await statsResponse.json();
                    console.log('Current stats:', stats);
                } catch (error) {
                    console.log('❌ Stats check failed:', error.message);
                }

                // Test 3: Check debug data
                console.log('\n🐛 Checking debug data...');
                try {
                    const debugResponse = await fetch(`${baseUrl}/api/debug/${domain}`);
                    const debug = await debugResponse.json();
                    console.log('Debug data:', {
                        totalRecords: debug.totalRecords,
                        database: debug.database,
                        sampleRecords: debug.sampleRecords?.length || 0
                    });
                } catch (error) {
                    console.log('❌ Debug check failed:', error.message);
                }
            }

            testTracking();