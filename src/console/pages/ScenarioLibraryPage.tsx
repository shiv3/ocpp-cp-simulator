import React from "react";

const PageStub: React.FC<{ title: string }> = ({ title }) => (
  <div className="p-6">
    <h2 className="text-lg font-semibold">{title}</h2>
    <p className="text-sm text-gray-500">Coming soon</p>
  </div>
);

const ScenarioLibraryPage: React.FC = () => <PageStub title="Scenarios" />;

export default ScenarioLibraryPage;
