import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import authRouter from '../auth.js';
import { User } from '../../models/user.js';
import { messagingService } from '../../services/messaging/messaging.service.js';

// Mock dependencies
vi.mock('../../models/user.js', () => ({
    User: {
        findOneAndUpdate: vi.fn(),
        findOne: vi.fn(),
        findById: vi.fn(),
        findByIdAndUpdate: vi.fn(),
    }
}));

vi.mock('../../services/messaging/messaging.service.js', () => ({
    messagingService: {
        sendOTP: vi.fn(),
    }
}));

vi.mock('../../middleware/auth.js', () => ({
    auth: (req, res, next) => {
        req.user = { id: 'mocked_user_id' };
        next();
    }
}));

// Setup app for testing router
const app = express();
app.use(express.json());
app.use('/auth', authRouter);

describe('Auth Routes', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('POST /auth/send-otp', () => {
        it('should return error for invalid mobile number format (less than 12 digits)', async () => {
            const response = await request(app)
                .post('/auth/send-otp')
                .send({ mobileNumber: '123' });

            expect(response.status).toBe(400);
            expect(response.body.error).toMatch(/Invalid mobile number/);
        });

        it('should successfully send OTP for valid number', async () => {
            User.findOneAndUpdate.mockResolvedValue({ mobileNumber: '919876543211', otp: '123456' });
            messagingService.sendOTP.mockResolvedValue({});

            const response = await request(app)
                .post('/auth/send-otp')
                .send({ mobileNumber: '919876543211' });

            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
            expect(User.findOneAndUpdate).toHaveBeenCalled();
            expect(messagingService.sendOTP).toHaveBeenCalled();
        });
    });
});
