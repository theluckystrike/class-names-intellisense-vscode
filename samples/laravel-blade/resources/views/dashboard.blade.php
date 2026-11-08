@extends('layouts.app')

@section('content')
<div class="dashboard">
    <h1 class="dashboard__heading">{{ __('Dashboard') }}</h1>
    @foreach ($projects as $project)
        <div class="project-row {{ $project->archived ? 'project-row--archived' : '' }} ">
            <span class="project-row__name">{{ $project->name }}</span>
            <span class="status-pill status-pill--{{ $project->status }}">{{ ucfirst($project->status) }}</span>
        </div>
    @endforeach
    <?php if ($canCreate): ?>
        <a class="btn-create" href="{{ route('projects.create') }}">New project</a>
    <?php endif; ?>
</div>
@endsection
