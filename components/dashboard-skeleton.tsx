import {cn} from "@/lib/utils";

interface SkeletonBlockProps {
  className?: string;
}

function SkeletonBlock({ className }: SkeletonBlockProps) {
  return <div className={cn("rounded-md bg-muted/40", className)} />;
}

function CardSkeleton() {
  return (
    <div className="flex flex-col gap-4 rounded-3xl border border-border/40 bg-background/40 p-5">
      <div className="flex items-center justify-between">
        <SkeletonBlock className="h-4 w-32" />
        <SkeletonBlock className="h-5 w-12 rounded-full" />
      </div>
      <SkeletonBlock className="h-6 w-24" />
      <SkeletonBlock className="h-3 w-40" />
      <SkeletonBlock className="h-16 w-full" />
      <div className="flex items-center gap-3">
        <SkeletonBlock className="h-3 w-20" />
        <SkeletonBlock className="h-3 w-16" />
      </div>
    </div>
  );
}

export function DashboardSkeleton() {
  return (
    <div className="relative animate-pulse">
      <header className="mb-8 flex flex-col justify-between gap-6 sm:mb-12 sm:gap-8 lg:flex-row lg:items-end">
        <div className="space-y-4">
          <SkeletonBlock className="h-4 w-36" />
          <SkeletonBlock className="h-10 w-72" />
          <SkeletonBlock className="h-4 w-64" />
        </div>
        <div className="flex flex-col items-start gap-3 sm:gap-4 lg:items-end">
          <SkeletonBlock className="h-8 w-48 rounded-full" />
          <SkeletonBlock className="h-8 w-40 rounded-full" />
          <SkeletonBlock className="h-4 w-52" />
        </div>
      </header>

      <main className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, index) => (
          <CardSkeleton key={`dashboard-skeleton-${index}`} />
        ))}
      </main>
    </div>
  );
}

export function GroupDashboardSkeleton() {
  return (
    <div className="relative animate-pulse">
      <header className="mb-8 flex flex-col justify-between gap-6 sm:mb-12 sm:gap-8 lg:flex-row lg:items-end">
        <div className="space-y-4">
          <SkeletonBlock className="h-4 w-28" />
          <SkeletonBlock className="h-10 w-60" />
          <SkeletonBlock className="h-4 w-40" />
        </div>
        <div className="flex flex-col items-start gap-3 sm:gap-4 lg:items-end">
          <SkeletonBlock className="h-8 w-40 rounded-full" />
          <SkeletonBlock className="h-8 w-36 rounded-full" />
          <SkeletonBlock className="h-4 w-52" />
        </div>
      </header>

      <section className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, index) => (
          <CardSkeleton key={`group-skeleton-${index}`} />
        ))}
      </section>
    </div>
  );
}
