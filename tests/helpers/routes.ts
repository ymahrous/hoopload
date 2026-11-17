import * as events from "@/app/api/events/route";
import * as file from "@/app/api/files/[id]/route";
import * as files from "@/app/api/files/route";
import * as health from "@/app/api/health/route";
import * as session from "@/app/api/session/route";
import * as chunk from "@/app/api/uploads/[id]/chunks/[index]/route";
import * as complete from "@/app/api/uploads/[id]/complete/route";
import * as upload from "@/app/api/uploads/[id]/route";
import * as uploads from "@/app/api/uploads/route";
import type { Routes } from "./http";

export const routes = { events, file, files, health, session, chunk, complete, upload, uploads } as unknown as Routes;
