"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase-browser";
import {
  Plus,
  Trash2,
  Save,
  ToggleLeft,
  ToggleRight,
  Shield,
  Utensils,
  Tv,
  Baby,
  AlertTriangle,
  Pencil,
  X,
  Check,
} from "lucide-react";

interface Category {
  id: string;
  key: string;
  label: string;
  description: string;
  is_active: boolean;
  sort_order: number;
}

const BRAND_GROUPS: Record<string, { label: string; icon: React.ElementType; keys: string[] }> = {
  general: {
    label: "General Moderation Logic",
    icon: Shield,
    keys: ["profanity", "lgbtqia_attack", "violent_language", "racism", "boycott_criticism", "sexual_content", "spam"],
  },
  food_health: {
    label: "Food & Health — Olive, Goodfood, Nutracheck",
    icon: Utensils,
    keys: ["fat_shaming", "eating_disorder"],
  },
  lifestyle: {
    label: "Lifestyle — Top Gear, Gardener World",
    icon: Tv,
    keys: ["ev_hostility", "greenwashing", "nature_wars", "elitism"],
  },
  parenting: {
    label: "Parenting & Kids — MadeforMums, CBeebies",
    icon: Baby,
    keys: ["paedophilia", "parent_shaming", "classism", "child_abuse"],
  },
};

export default function CategoriesPage() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ label: "", description: "", confidence_threshold: 0.8 });
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ key: "", label: "", description: "", confidence_threshold: 0.8 });
  const supabase = createClient();

  const fetchCategories = useCallback(async () => {
    setLoading(true);
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;

    const res = await fetch("/api/categories", {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    if (res.ok) {
      const data = await res.json();
      setCategories(data);
    }
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    fetchCategories();
  }, [fetchCategories]);

  async function toggleCategory(cat: Category) {
    setSaving(cat.id);
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;

    await fetch("/api/categories", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ id: cat.id, is_active: !cat.is_active }),
    });

    setCategories((prev) =>
      prev.map((c) => (c.id === cat.id ? { ...c, is_active: !c.is_active } : c))
    );
    setSaving(null);
  }

  async function saveEdit(cat: Category) {
    setSaving(cat.id);
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;

    await fetch("/api/categories", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ id: cat.id, label: editForm.label, description: editForm.description }),
    });

    setCategories((prev) =>
      prev.map((c) =>
        c.id === cat.id ? { ...c, label: editForm.label, description: editForm.description } : c
      )
    );
    setEditingId(null);
    setSaving(null);
  }

  async function deleteCategory(id: string) {
    if (!confirm("Delete this category?")) return;
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;

    await fetch(`/api/categories?id=${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${session.access_token}` },
    });

    setCategories((prev) => prev.filter((c) => c.id !== id));
  }

  async function addCategory() {
    if (!addForm.key || !addForm.label) return;
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;

    const res = await fetch("/api/categories", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify(addForm),
    });

    if (res.ok) {
      const data = await res.json();
      setCategories((prev) => [...prev, data]);
      setAddForm({ key: "", label: "", description: "" });
      setShowAdd(false);
    }
  }

  function getGroupedCategories() {
    const grouped: Record<string, Category[]> = {};
    const ungrouped: Category[] = [];

    for (const cat of categories) {
      let found = false;
      for (const [groupKey, group] of Object.entries(BRAND_GROUPS)) {
        if (group.keys.includes(cat.key)) {
          if (!grouped[groupKey]) grouped[groupKey] = [];
          grouped[groupKey].push(cat);
          found = true;
          break;
        }
      }
      if (!found) ungrouped.push(cat);
    }

    return { grouped, ungrouped };
  }

  const { grouped, ungrouped } = getGroupedCategories();
  const activeCount = categories.filter((c) => c.is_active).length;

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-surface-900">AI Moderation Categories</h1>
          <p className="text-surface-500 text-sm mt-1">
            {activeCount} of {categories.length} categories active — GPT-4o analyses each comment against all active categories
          </p>
        </div>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="flex items-center gap-2 bg-brand-500 text-white px-4 py-2.5 rounded-xl text-sm font-semibold hover:bg-brand-600 transition-colors"
        >
          <Plus className="w-4 h-4" />
          Add Category
        </button>
      </div>

      {/* Add form */}
      {showAdd && (
        <div className="bg-white rounded-2xl border border-surface-200 p-6 mb-6">
          <h3 className="font-semibold text-surface-800 mb-4">New Custom Category</h3>
          <div className="grid grid-cols-2 gap-4 mb-4">
            <div>
              <label className="block text-xs font-medium text-surface-500 mb-1">Key (machine name)</label>
              <input
                type="text"
                value={addForm.key}
                onChange={(e) => setAddForm({ ...addForm, key: e.target.value })}
                placeholder="e.g. brand_criticism"
                className="w-full border border-surface-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-surface-500 mb-1">Label (display name)</label>
              <input
                type="text"
                value={addForm.label}
                onChange={(e) => setAddForm({ ...addForm, label: e.target.value })}
                placeholder="e.g. Brand Criticism"
                className="w-full border border-surface-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500"
              />
            </div>
            <div className="col-span-2">
              <label className="block text-xs font-medium text-surface-500 mb-1">
                Confidence Threshold ({addForm.confidence_threshold})
              </label>
              <input
                type="range"
                min="0.1"
                max="1.0"
                step="0.05"
                value={addForm.confidence_threshold}
                onChange={(e) => setAddForm({ ...addForm, confidence_threshold: parseFloat(e.target.value) })}
                className="w-full accent-brand-500"
              />
              <p className="text-[10px] text-surface-400 mt-1">
                Minimum confidence score (0.0 - 1.0) required to trigger this category.
              </p>
            </div>
          </div>
          <div className="mb-4">
            <label className="block text-xs font-medium text-surface-500 mb-1">
              Description (AI instruction — be specific about what to detect)
            </label>
            <textarea
              value={addForm.description}
              onChange={(e) => setAddForm({ ...addForm, description: e.target.value })}
              rows={3}
              placeholder="Describe what this category should detect. Be specific for better AI accuracy."
              className="w-full border border-surface-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500"
            />
          </div>
          <div className="flex gap-3">
            <button onClick={addCategory} className="bg-brand-500 text-white px-4 py-2 rounded-xl text-sm font-semibold hover:bg-brand-600 transition-colors flex items-center gap-2">
              <Save className="w-4 h-4" /> Save
            </button>
            <button onClick={() => setShowAdd(false)} className="text-surface-500 px-4 py-2 rounded-xl text-sm hover:text-surface-700">
              Cancel
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-center py-16 text-surface-400">Loading categories...</div>
      ) : (
        <>
          {/* Brand-grouped sections */}
          {Object.entries(BRAND_GROUPS).map(([groupKey, group]) => {
            const cats = grouped[groupKey] || [];
            if (cats.length === 0) return null;
            const Icon = group.icon;

            return (
              <div key={groupKey} className="mb-8">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-8 h-8 rounded-lg bg-brand-500/10 flex items-center justify-center">
                    <Icon className="w-4 h-4 text-brand-500" />
                  </div>
                  <h2 className="font-semibold text-surface-800">{group.label}</h2>
                </div>

                <div className="space-y-2">
                  {cats.map((cat) => (
                    <CategoryRow
                      key={cat.id}
                      cat={cat}
                      saving={saving}
                      editingId={editingId}
                      editForm={editForm}
                      setEditForm={setEditForm}
                      setEditingId={setEditingId}
                      onToggle={() => toggleCategory(cat)}
                      onSaveEdit={() => saveEdit(cat)}
                      onDelete={() => deleteCategory(cat.id)}
                    />
                  ))}
                </div>
              </div>
            );
          })}

          {/* Ungrouped / custom categories */}
          {ungrouped.length > 0 && (
            <div className="mb-8">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-8 h-8 rounded-lg bg-surface-200 flex items-center justify-center">
                  <AlertTriangle className="w-4 h-4 text-surface-500" />
                </div>
                <h2 className="font-semibold text-surface-800">Custom Categories</h2>
              </div>

              <div className="space-y-2">
                {ungrouped.map((cat) => (
                  <CategoryRow
                    key={cat.id}
                    cat={cat}
                    saving={saving}
                    editingId={editingId}
                    editForm={editForm}
                    setEditForm={setEditForm}
                    setEditingId={setEditingId}
                    onToggle={() => toggleCategory(cat)}
                    onSaveEdit={() => saveEdit(cat)}
                    onDelete={() => deleteCategory(cat.id)}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function CategoryRow({
  cat,
  saving,
  editingId,
  editForm,
  setEditForm,
  setEditingId,
  onToggle,
  onSaveEdit,
  onDelete,
}: {
  cat: Category;
  saving: string | null;
  editingId: string | null;
  editForm: { label: string; description: string };
  setEditForm: (f: { label: string; description: string }) => void;
  setEditingId: (id: string | null) => void;
  onToggle: () => void;
  onSaveEdit: () => void;
  onDelete: () => void;
}) {
  const isEditing = editingId === cat.id;

  return (
    <div
      className={`bg-white rounded-xl border transition-all ${
        cat.is_active ? "border-surface-200" : "border-surface-100 opacity-60"
      }`}
    >
      <div className="flex items-start gap-4 p-4">
        {/* Toggle */}
        <button
          onClick={onToggle}
          disabled={saving === cat.id}
          className="mt-0.5 flex-shrink-0"
        >
          {cat.is_active ? (
            <ToggleRight className="w-8 h-5 text-brand-500" />
          ) : (
            <ToggleLeft className="w-8 h-5 text-surface-300" />
          )}
        </button>

        {/* Content */}
        <div className="flex-1 min-w-0">
          {isEditing ? (
            <div className="space-y-3">
              <div className="flex gap-3">
                <input
                  type="text"
                  value={editForm.label}
                  onChange={(e) => setEditForm({ ...editForm, label: e.target.value })}
                  className="flex-1 border border-surface-200 rounded-lg px-3 py-2 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-brand-500/30"
                />
                <div className="flex items-center gap-2 bg-surface-50 border border-surface-200 rounded-lg px-3">
                   <span className="text-xs text-surface-500 font-medium">Threshold:</span>
                   <input
                    type="number"
                    min="0.1"
                    max="1.0"
                    step="0.05"
                    value={editForm.confidence_threshold}
                    onChange={(e) => setEditForm({ ...editForm, confidence_threshold: parseFloat(e.target.value) })}
                    className="w-16 bg-transparent text-sm focus:outline-none"
                   />
                </div>
              </div>
              <textarea
                value={editForm.description}
                onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                rows={2}
                className="w-full border border-surface-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/30"
              />
              <div className="flex gap-2">
                <button
                  onClick={onSaveEdit}
                  className="text-brand-500 hover:text-brand-600 p-1"
                >
                  <Check className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setEditingId(null)}
                  className="text-surface-400 hover:text-surface-600 p-1"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <span className="font-semibold text-sm text-surface-800">{cat.label}</span>
                <span className="text-[11px] font-mono text-surface-400 bg-surface-100 px-2 py-0.5 rounded">
                  {cat.key}
                </span>
              </div>
              <p className="text-sm text-surface-500 mt-1 leading-relaxed">{cat.description}</p>
            </>
          )}
        </div>

        {/* Actions */}
        {!isEditing && (
          <div className="flex gap-1 flex-shrink-0">
            <button
              onClick={() => {
                setEditingId(cat.id);
                setEditForm({ label: cat.label, description: cat.description, confidence_threshold: cat.confidence_threshold ?? 0.8 });
              }}
              className="p-2 text-surface-400 hover:text-surface-600 hover:bg-surface-100 rounded-lg transition-colors"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={onDelete}
              className="p-2 text-surface-400 hover:text-danger-500 hover:bg-danger-50 rounded-lg transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
