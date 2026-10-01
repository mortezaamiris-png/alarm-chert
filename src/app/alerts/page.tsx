"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";

interface Alert {
  id: string;
  symbol: string;
  price: number;
  condition: "above" | "below";
  created_at: string;
  is_active: boolean;
}

export default function AlertsPage() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [price, setPrice] = useState("");
  const [condition, setCondition] = useState<"above" | "below">("above");
  const [loading, setLoading] = useState(false);

  // بارگذاری آلارم‌های فعال از سوپابیس
  useEffect(() => {
    fetchAlerts();
  }, []);

  const fetchAlerts = async () => {
    const { data, error } = await supabase
      .from("alarms")
      .select("*")
      .eq("is_active", true)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Error fetching alerts:", error);
      return;
    }
    setAlerts(data || []);
  };

  const addAlert = async () => {
    if (!price || isNaN(Number(price))) {
      alert("لطفاً قیمت معتبر وارد کن");
      return;
    }

    setLoading(true);

    const { data, error } = await supabase
      .from("alarms")
      .insert([
