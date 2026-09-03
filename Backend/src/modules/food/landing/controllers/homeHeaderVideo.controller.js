import * as homeHeaderVideoService from '../services/homeHeaderVideo.service.js';

export const listHomeHeaderVideosController = async (req, res, next) => {
    try {
        const videos = await homeHeaderVideoService.listHomeHeaderVideos();
        res.status(200).json({ success: true, videos });
    } catch (error) {
        next(error);
    }
};

export const createHomeHeaderVideoController = async (req, res, next) => {
    try {
        const file = req.file;
        const video = await homeHeaderVideoService.createHomeHeaderVideo(file);
        res.status(201).json({ success: true, video });
    } catch (error) {
        next(error);
    }
};

export const deleteHomeHeaderVideoController = async (req, res, next) => {
    try {
        const { id } = req.params;
        const result = await homeHeaderVideoService.deleteHomeHeaderVideo(id);
        res.status(200).json({ success: true, ...result });
    } catch (error) {
        next(error);
    }
};

export const toggleHomeHeaderVideoStatusController = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { isActive } = req.body;
        const video = await homeHeaderVideoService.toggleHomeHeaderVideoStatus(id, isActive);
        res.status(200).json({ success: true, video });
    } catch (error) {
        next(error);
    }
};

// Never a 404: no header video configured yet is a normal state, not an error.
export const getPublicHomeHeaderVideoController = async (req, res, next) => {
    try {
        const video = await homeHeaderVideoService.getActiveHomeHeaderVideo();
        res.status(200).json({ success: true, video: video || null });
    } catch (error) {
        next(error);
    }
};
