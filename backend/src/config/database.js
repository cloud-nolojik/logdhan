import mongoose from 'mongoose';

const connectDB = async () => {
  try {
    const mongoUri = process.env.MONGODB_URI;

    // Log connection attempt (mask credentials for security)
    const maskedUri = mongoUri ? mongoUri.replace(/:([^:@]+)@/, ':****@') : 'undefined';
    console.log(`[MongoDB] Attempting to connect to: ${maskedUri}`);
    console.log(`[MongoDB] Connection state before connect: ${mongoose.connection.readyState}`);
    // 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting

    if (!mongoUri) {
      throw new Error('MONGODB_URI environment variable is not defined');
    }

    const conn = await mongoose.connect(mongoUri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 30000, // 30 seconds to select server
      socketTimeoutMS: 45000, // 45 seconds for socket operations
      connectTimeoutMS: 30000, // 30 seconds to establish connection
    });

    console.log(`[MongoDB] ✅ Connected successfully to: ${conn.connection.host}`);
    console.log(`[MongoDB] Database name: ${conn.connection.name}`);
    console.log(`[MongoDB] Connection state after connect: ${mongoose.connection.readyState}`);

  } catch (error) {
    console.error(`[MongoDB] ❌ Connection error: ${error.message}`);
    console.error(`[MongoDB] Error stack: ${error.stack}`);
    process.exit(1);
  }
};

// Add connection event listeners for monitoring
mongoose.connection.on('connected', () => {
  console.log('[MongoDB] Mongoose connected to database');
});

mongoose.connection.on('error', (err) => {
  console.error(`[MongoDB] Mongoose connection error: ${err.message}`);
});

mongoose.connection.on('disconnected', () => {
  console.log('[MongoDB] Mongoose disconnected from database');
});

mongoose.connection.on('reconnected', () => {
  console.log('[MongoDB] Mongoose reconnected to database');
});

mongoose.connection.on('reconnectFailed', () => {
  console.error('[MongoDB] Mongoose reconnection failed');
});

// Handle process termination
process.on('SIGINT', async () => {
  await mongoose.connection.close();
  console.log('[MongoDB] Connection closed due to app termination');
  process.exit(0);
});

export default connectDB;