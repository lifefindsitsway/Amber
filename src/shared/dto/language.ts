import { z } from "zod";

/** BCP-47 shape only; whether a language is offered in the UI is not validated here. */
export const languageTagSchema = z.string().regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/);
