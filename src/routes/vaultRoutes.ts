// src/routes/vaultRoutes.ts
import express, { Request, Response, NextFunction } from 'express';
import {
    handleUnlockVault,
    handleGetContractBalance,
    handleDistributeFunds,
    handleGetExpirationTime
} from '../controllers/vaultController';
import { body, validationResult, query } from 'express-validator';

const router = express.Router();

// GET /api/vault/balance
router.get(
    '/balance',
    [
        query('challenge_id')
            .exists().withMessage('challenge_id is required')
            .notEmpty().withMessage('challenge_id cannot be empty'),
        (req: Request, res: Response, next: NextFunction): void => {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                res.status(400).json({ errors: errors.array() });
            } else {
                next();
            }
        },
    ],
    handleGetContractBalance
);

// POST /api/vault/unlock
router.post(
    '/unlock',
    [
        body('user_address')
            .exists().withMessage('user_address is required')
            .isEthereumAddress().withMessage('Invalid Ethereum address'),
        body('participant_id')
            .exists().withMessage('participant_id is required')
            .notEmpty().withMessage('participant_id cannot be empty'),
        body('conversation_id')
            .exists().withMessage('conversation_id is required')
            .notEmpty().withMessage('conversation_id cannot be empty'),
        body('challenge_id')
            .exists().withMessage('challenge_id is required')
            .notEmpty().withMessage('challenge_id cannot be empty'),
        body('password')
            .exists().withMessage('password is required')
            .notEmpty().withMessage('password cannot be empty'),
        (req: Request, res: Response, next: NextFunction): void => {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                res.status(400).json({ errors: errors.array() });
            } else {
                next();
            }
        },
    ],
    handleUnlockVault
);

// POST /api/vault/distribute
router.post(
    '/distribute',
    [
        body('challenge_id')
            .exists().withMessage('challenge_id is required')
            .isEthereumAddress().withMessage('Invalid Ethereum address'),
        (req: Request, res: Response, next: NextFunction): void => {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                res.status(400).json({ errors: errors.array() });
            } else {
                next();
            }
        },
    ],
    handleDistributeFunds
);

// GET /api/vault/expiration
router.get(
    '/expiration',
    [
        query('challenge_id')
            .exists().withMessage('challenge_id is required')
            .notEmpty().withMessage('challenge_id cannot be empty'),
        (req: Request, res: Response, next: NextFunction): void => {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                res.status(400).json({ errors: errors.array() });
            } else {
                next();
            }
        },
    ],
    handleGetExpirationTime
);

export default router;
