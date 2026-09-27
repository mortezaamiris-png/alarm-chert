import { createClient } from "@supabase/supabase-js";

const supabaseUrl = "https://ddykxhyhjhyhrpbsbdhp.supabase.co";
const supabaseKey = "sb_publishable_2_fWB9Mp5r9M0KUhGkkkUA_Nd6LRX2i";

export const supabase = createClient(supabaseUrl, supabaseKey);
