import './src/loadEnv.js'; // Load environment variables
import mongoose from 'mongoose';
import StockLog from './src/models/stockLog.js';

// Connect to MongoDB
const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('✅ MongoDB connected successfully');
    } catch (error) {
        console.error('❌ MongoDB connection error:', error);
        process.exit(1);
    }
};

// Fix review status for trades that don't need review
const fixReviewStatus = async () => {
    try {
        console.log('🔧 Starting review status cleanup...');
        
        // Find all trades where needsReview is false but reviewStatus is set
        const incorrectTrades = await StockLog.find({
            needsReview: false,
            reviewStatus: { $exists: true, $ne: null }
        });
        
        console.log(`📊 Found ${incorrectTrades.length} trades with incorrect reviewStatus`);
        
        if (incorrectTrades.length > 0) {
            // Show examples before fixing
            console.log('📋 Examples of trades to fix:');
            incorrectTrades.slice(0, 5).forEach(trade => {
                console.log(`  - Trade ${trade._id}: needsReview=${trade.needsReview}, reviewStatus=${trade.reviewStatus}`);
            });
            
            // Update trades to remove reviewStatus when needsReview is false
            const result = await StockLog.updateMany(
                {
                    needsReview: false,
                    reviewStatus: { $exists: true, $ne: null }
                },
                {
                    $unset: { 
                        reviewStatus: "",
                        reviewResult: "",
                        reviewRequestedAt: "",
                        reviewCompletedAt: "",
                        reviewError: "",
                        reviewMetadata: "",
                        isFromRewardedAd: "",
                        creditType: ""
                    }
                }
            );
            
            console.log(`✅ Updated ${result.modifiedCount} trades`);
            console.log(`   - Removed reviewStatus and related fields from trades that don't need review`);
        } else {
            console.log('✅ No trades found with incorrect reviewStatus');
        }
        
        // Verify the fix
        const remainingIncorrect = await StockLog.countDocuments({
            needsReview: false,
            reviewStatus: { $exists: true, $ne: null }
        });
        
        console.log(`🔍 Verification: ${remainingIncorrect} trades still have incorrect reviewStatus`);
        
        if (remainingIncorrect === 0) {
            console.log('🎉 All trades have been fixed successfully!');
        }
        
    } catch (error) {
        console.error('❌ Error fixing review status:', error);
    }
};

// Main execution
const main = async () => {
    await connectDB();
    await fixReviewStatus();
    await mongoose.connection.close();
    console.log('🔚 Database connection closed');
    process.exit(0);
};

main();