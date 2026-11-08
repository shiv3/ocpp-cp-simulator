import { useTranslation } from "react-i18next";
import React from "react";
import { Languages, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LOCALES, LOCALE_LABELS, setLocale } from "../i18n";

/** Language picker. Mirrors ThemeToggle so the two sit side by side in the
 * sidebar footer. */
const LanguageToggle: React.FC = () => {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("common.language.toggle")}
          title={t("common.language.toggle")}
        >
          <Languages className="h-5 w-5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {LOCALES.map((code) => (
          <DropdownMenuItem
            key={code}
            lang={code}
            onClick={() => void setLocale(code)}
          >
            {LOCALE_LABELS[code]}
            {locale === code && <Check className="ml-auto h-4 w-4" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default LanguageToggle;
