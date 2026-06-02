import { createClient } from "@sanity/client";
import { env } from "./env";

export const sanityClient = createClient({
  projectId: env.sanityProjectId,
  dataset: env.sanityDataset,
  apiVersion: env.sanityApiVersion,
  useCdn: false,
  token: env.sanityApiToken || undefined,
  perspective: env.sanityApiToken ? "drafts" : "published",
});
