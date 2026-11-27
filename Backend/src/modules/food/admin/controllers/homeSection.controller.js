import { sendResponse } from '../../../../utils/response.js';
import {
  createHomeSection,
  listHomeSectionsAdmin,
  updateHomeSection,
  deleteHomeSection,
  listHomeSectionsForUser,
  getHomeSectionDetail,
} from '../services/homeSection.service.js';

// ------------------------------------------------------------------ admin side

export const createHomeSectionController = async (req, res, next) => {
  try {
    const data = await createHomeSection(req.body || {});
    return sendResponse(res, 201, 'Home section created', data);
  } catch (error) {
    next(error);
  }
};

export const listHomeSectionsAdminController = async (req, res, next) => {
  try {
    const data = await listHomeSectionsAdmin();
    return sendResponse(res, 200, 'Home sections fetched', data);
  } catch (error) {
    next(error);
  }
};

export const updateHomeSectionController = async (req, res, next) => {
  try {
    const data = await updateHomeSection(req.params.id, req.body || {});
    return sendResponse(res, 200, 'Home section updated', data);
  } catch (error) {
    next(error);
  }
};

export const deleteHomeSectionController = async (req, res, next) => {
  try {
    const data = await deleteHomeSection(req.params.id);
    return sendResponse(res, 200, 'Home section deleted', data);
  } catch (error) {
    next(error);
  }
};

// ------------------------------------------------------------------- user side

export const listHomeSectionsUserController = async (req, res, next) => {
  try {
    const data = await listHomeSectionsForUser({ zoneId: req.query.zoneId });
    return sendResponse(res, 200, 'Home sections fetched', data);
  } catch (error) {
    next(error);
  }
};

export const getHomeSectionDetailController = async (req, res, next) => {
  try {
    const data = await getHomeSectionDetail(req.params.id);
    return sendResponse(res, 200, 'Home section detail fetched', data);
  } catch (error) {
    next(error);
  }
};
