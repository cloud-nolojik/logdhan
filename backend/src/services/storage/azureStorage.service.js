import { BlobServiceClient } from '@azure/storage-blob';
import path from 'path';
import fs from 'fs';

class AzureStorageService {
  constructor() {
    this.connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
    this.containerName = process.env.AZURE_BLOB_CONTAINER_NAME || 'charts';
    
    if (!this.connectionString) {
      console.warn('⚠️ Azure Storage connection string not found. Chart uploads will use local storage.');
      this.enabled = false;
      return;
    }

    try {
      this.blobServiceClient = BlobServiceClient.fromConnectionString(this.connectionString);
      this.containerClient = this.blobServiceClient.getContainerClient(this.containerName);
      this.enabled = true;
      console.log('✅ Azure Blob Storage service initialized');
    } catch (error) {
      console.error('❌ Failed to initialize Azure Blob Storage:', error.message);
      this.enabled = false;
    }
  }

  /**
   * Initialize container (create if doesn't exist)
   */
  async initializeContainer() {
    if (!this.enabled) return;

    try {
      // Create container if it doesn't exist (with public read access for images)
      const createContainerResponse = await this.containerClient.createIfNotExists({
        access: 'blob' // Public read access for individual blobs
      });

      if (createContainerResponse.succeeded) {
        console.log(`✅ Azure container '${this.containerName}' created or already exists`);
      }
    } catch (error) {
      console.error('❌ Failed to initialize Azure container:', error.message);
      this.enabled = false;
    }
  }

  /**
   * Upload a file to Azure Blob Storage
   * @param {string} localFilePath - Path to local file
   * @param {string} blobName - Name for the blob (including extension)
   * @returns {Promise<string>} - Public URL of uploaded file
   */
  async uploadFile(localFilePath, blobName) {
    if (!this.enabled) {
      throw new Error('Azure Storage not properly initialized');
    }

    try {
      // Ensure container exists
      await this.initializeContainer();

      // Get blob client
      const blockBlobClient = this.containerClient.getBlockBlobClient(blobName);

      // Set content type based on file extension
      const contentType = this.getContentType(blobName);

      // Upload file
      const uploadBlobResponse = await blockBlobClient.uploadFile(localFilePath, {
        blobHTTPHeaders: {
          blobContentType: contentType,
          blobCacheControl: 'public, max-age=3600' // 1 hour cache
        }
      });

      console.log(`✅ Uploaded ${blobName} to Azure Blob Storage`);

      // Return public URL (use CDN if available, otherwise direct blob URL)
      const publicUrl = blockBlobClient.url;

      // Clean up local file after successful upload
      if (fs.existsSync(localFilePath)) {
        fs.unlinkSync(localFilePath);
        console.log(`🗑️ Cleaned up local file: ${localFilePath}`);
      }

      return publicUrl;

    } catch (error) {
      console.error(`❌ Failed to upload ${blobName} to Azure:`, error.message);
      throw error;
    }
  }

  /**
   * Upload chart image specifically
   * @param {string} localFilePath - Path to local chart file  
   * @param {string} fileName - Chart file name
   * @returns {Promise<string>} - Public URL of uploaded chart
   */
  async uploadChart(localFilePath, fileName) {
    const blobName = `charts/${fileName}`;
    return await this.uploadFile(localFilePath, blobName);
  }

  /**
   * Delete a blob from storage
   * @param {string} blobName - Name of blob to delete
   */
  async deleteBlob(blobName) {
    if (!this.enabled) return;

    try {
      const blobClient = this.containerClient.getBlobClient(blobName);
      await blobClient.deleteIfExists();
      console.log(`🗑️ Deleted blob: ${blobName}`);
    } catch (error) {
      console.error(`❌ Failed to delete blob ${blobName}:`, error.message);
    }
  }

  /**
   * Clean up old chart files (older than specified hours)
   * @param {number} hoursOld - Delete files older than this many hours
   */
  async cleanupOldCharts(hoursOld = 24) {
    if (!this.enabled) return;

    try {
      const cutoffTime = new Date(Date.now() - (hoursOld * 60 * 60 * 1000));
      
      for await (const blob of this.containerClient.listBlobsFlat({ prefix: 'charts/' })) {
        if (blob.properties.createdOn < cutoffTime) {
          await this.deleteBlob(blob.name);
        }
      }
      
      console.log(`🧹 Cleaned up charts older than ${hoursOld} hours`);
    } catch (error) {
      console.error('❌ Failed to cleanup old charts:', error.message);
    }
  }

  /**
   * Get content type based on file extension
   * @param {string} fileName - File name with extension
   * @returns {string} - MIME type
   */
  getContentType(fileName) {
    const ext = path.extname(fileName).toLowerCase();
    const mimeTypes = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.webp': 'image/webp'
    };
    return mimeTypes[ext] || 'application/octet-stream';
  }

  /**
   * Check if Azure storage is enabled and working
   * @returns {boolean}
   */
  isEnabled() {
    return this.enabled;
  }
}

export const azureStorageService = new AzureStorageService();